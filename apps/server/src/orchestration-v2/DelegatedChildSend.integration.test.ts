import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

it.effect("a parent's auto follow-up to a running Claude child stays in the child's task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("delegated-child-send");
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      const steers: Array<string> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: ClaudeProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  turns.push({ turn, events });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (input) => Effect.sync(() => void steers.push(input.message.text)),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "delegated-child-send" },
        ProviderAdapterRegistry.layerSingle(adapter),
        { runEffectWorker: false },
      );
      const layerTest = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const projectId = ProjectId.make("project:delegated-child-send");
        const parentThreadId = ThreadId.make("thread:delegated-child-send-parent");
        const turnRunning = () =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event: OrchestrationV2DomainEvent) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const runEnded = (runId: string) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event: OrchestrationV2DomainEvent) =>
                event.type === "run.updated" &&
                event.payload.id === runId &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const endTurn = (entry: (typeof turns)[number]) =>
          Queue.offer(entry.events, {
            type: "turn.terminal",
            driver,
            providerThreadId: entry.turn.providerThread.id,
            providerTurnId: ProviderTurnId.make(`provider-turn:${entry.turn.attemptId}`),
            runOrdinal: entry.turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        // Settling runs in a background reactor; recovery evaluates every child deterministically.
        const settledTask = (taskId: string) =>
          Effect.gen(function* () {
            yield* orchestrator.recoverDelegatedTasks;
            yield* worker.drain();
            const parent = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(parent.subagents.length, 1);
            return parent.subagents.find((row) => row.id === taskId)!;
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const parentRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Delegate a review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(parentRunning);
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        const childRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        const childThreadId = task.childThreadId!;

        const sent = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make("follow-up"),
          threadId: childThreadId,
          senderThreadId: parentThreadId,
          messageId: MessageId.make("message:follow-up"),
          text: "Also check the tests.",
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
        });
        assert.equal(sent.delivery, "queued");
        assert.deepEqual(steers, []);

        const childTurns = () => turns.filter((entry) => entry.turn.threadId === childThreadId);
        const firstEnded = yield* runEnded(childTurns()[0]!.turn.runId);
        const followUpRunning = yield* turnRunning();
        yield* endTurn(childTurns()[0]!);
        yield* Fiber.join(firstEnded);
        yield* worker.drain();
        // The task waits for the follow-up instead of settling with the earlier turn's result.
        assert.isNull((yield* settledTask(task.id)).result);
        yield* Fiber.join(followUpRunning);

        const followUp = childTurns()[1]!;
        assert.equal(followUp.turn.runId, sent.run.id);
        const followUpEnded = yield* runEnded(followUp.turn.runId);
        yield* endTurn(followUp);
        yield* Fiber.join(followUpEnded);
        yield* worker.drain();
        const settled = yield* settledTask(task.id);
        assert.equal(settled.status, "completed");
        assert.equal(settled.completionDelivery?.state, "claimed");
      }).pipe(Effect.provide(layerTest));
    }),
  ),
);
