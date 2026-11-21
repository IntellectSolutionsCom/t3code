import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { type NativeSessionMark, NativeSessionOut } from "./NativeSessionOut.ts";
import * as NativeSessionGate from "./nativeSessionGate.ts";
import { makeHandout, takeBackNotice } from "./nativeSessionHandout.ts";

const driver = ProviderDriverKind.make("codex");
const selection = {
  instanceId: ProviderInstanceId.make("codex-gate-test"),
  model: "gate-model",
} satisfies ModelSelection;

interface Calls {
  readonly opens: number;
  readonly ensures: number;
  readonly resumes: number;
  readonly starts: number;
}

/** Turns on `held` never end, so that thread keeps working. */
const makeAdapter = (
  calls: Ref.Ref<Calls>,
  held: ThreadId | undefined,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId: selection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" } as const),
  openSession: (session) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (current) => ({ ...current, opens: current.opens + 1 }));
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: session.providerSessionId,
        driver,
        providerInstanceId: selection.instanceId,
        status: "ready",
        cwd: session.runtimePolicy.cwd ?? "/fallback",
        model: session.modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      return {
        instanceId: selection.instanceId,
        driver,
        providerSessionId: session.providerSessionId,
        providerSession,
        events: Stream.fromQueue(events),
        ensureThread: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (current) => ({ ...current, ensures: current.ensures + 1 }));
            const createdAt = yield* DateTime.now;
            return {
              id: ProviderThreadId.make(`provider-thread:${input.threadId}`),
              driver,
              providerInstanceId: selection.instanceId,
              providerSessionId: session.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${input.threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) =>
          Ref.update(calls, (current) => ({ ...current, resumes: current.resumes + 1 })).pipe(
            Effect.as(providerThread),
          ),
        startTurn: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (current) => ({ ...current, starts: current.starts + 1 }));
            if (input.providerThread.appThreadId === held) return;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
            const occurredAt = yield* DateTime.now;
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${providerTurnId}`, strength: "strong" },
                ordinal: input.providerTurnOrdinal,
                status: "completed",
                startedAt: occurredAt,
                completedAt: occurredAt,
              },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: input.providerThread.id,
              providerTurnId,
              runOrdinal: input.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
    }),
});

const makeMarks = Effect.gen(function* () {
  const marks = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, NativeSessionMark>>(new Map());
  const get = (threadId: ThreadId) =>
    SubscriptionRef.get(marks).pipe(Effect.map((current) => current.get(threadId)));
  const clear = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const mark = yield* get(threadId);
      yield* SubscriptionRef.update(marks, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
      return mark;
    });
  const takeBacks = yield* Ref.make<
    ReadonlyMap<ThreadId, NativeSessionMark & { readonly takenBackAt: string }>
  >(new Map());
  return NativeSessionOut.of({
    get,
    getTakeBack: (threadId) =>
      Ref.get(takeBacks).pipe(Effect.map((current) => current.get(threadId))),
    takeBack: (threadId, takenBackAt) =>
      Effect.gen(function* () {
        const mark = yield* clear(threadId);
        if (mark !== undefined) {
          yield* Ref.update(takeBacks, (current) =>
            new Map(current).set(threadId, { ...mark, takenBackAt }),
          );
        }
      }),
    set: (mark) =>
      SubscriptionRef.update(marks, (current) => new Map(current).set(mark.threadId, mark)),
    clear,
    marks: SubscriptionRef.changes(marks).pipe(Stream.map((current) => [...current.values()])),
  });
});

const withThread = <A, E>(
  name: string,
  test: (input: {
    readonly threadId: ThreadId;
    readonly calls: Ref.Ref<Calls>;
    readonly out: NativeSessionOut["Service"];
    readonly send: (text: string) => Effect.Effect<void, never, Scope.Scope>;
    readonly cwd: string;
  }) => Effect.Effect<A, E, Scope.Scope | HarnessServices>,
  held?: ThreadId,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const threadId = ThreadId.make(`thread:${name}`);
    const calls = yield* Ref.make<Calls>({ opens: 0, ensures: 0, resumes: 0, starts: 0 });
    const out = yield* makeMarks;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      // Waits for the run the message starts to finish, whichever way it ends.
      const send = Effect.fn("send")(function* (text: string) {
        const done = yield* eventSink
          .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
          .pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${name}:${text}`),
          threadId,
          messageId: MessageId.make(`message:${name}:${text}`),
          text,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Fiber.join(done);
        yield* worker.drain();
      }, Effect.orDie);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:${name}:create`),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: name,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      yield* send("first");
      return yield* test({ threadId, calls, out, send, cwd });
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name },
          ProviderAdapterRegistry.layerSingle(makeAdapter(calls, held)),
          {
            wrapProviderSessionManager: (manager) =>
              NativeSessionGate.makeGate(manager, {
                get: out.get,
                getTakeBack: out.getTakeBack,
                drop: (threadId) => out.clear(threadId).pipe(Effect.ignore),
              }),
          },
        ),
      ),
    );
  });

type HarnessServices =
  | Orchestrator.OrchestratorV2
  | EffectWorker.OrchestrationEffectWorkerV2
  | EventSink.EventSinkV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ThreadCommandExecutor.ThreadCommandExecutor;

const REFUSAL =
  "This thread's session is open in Codex's own client. Take it back here to continue.";

const errorMessages = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems.flatMap((item) => (item.type === "error" ? [item.failure.message] : []));

const handoutFor = (out: NativeSessionOut["Service"]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* makeHandout.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(NativeSessionOut, out),
          IdAllocator.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: orchestrator.getThreadShell,
            getProjectThreadRecords: (input, fields) =>
              orchestrator.getThreadRecords(input.threadId, fields) as never,
          }),
        ),
      ),
    );
  });

// Live: the effect worker retries an in-use refusal on its wall-clock backoff before the run fails.
it.live("refuses every send to an out thread without opening its session", () =>
  withThread("native-session-gate", ({ threadId, calls, out, send }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const before = yield* Ref.get(calls);
      const providerThread = (yield* orchestrator.getThreadProjection(threadId)).providerThreads[0];
      assert.isDefined(providerThread);
      yield* out.set({
        threadId,
        driver,
        nativeId: providerThread!.nativeThreadRef!.nativeId!,
        since: "2026-11-16T14:02:00.000Z",
      });

      yield* send("loaded");
      yield* send("loaded again");
      yield* sessions.release({
        providerSessionId: providerThread!.providerSessionId!,
        reason: "manual_shutdown",
      });
      yield* send("unloaded");

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map((run) => [run.status, run.startedAt === null]),
        [
          ["completed", false],
          ["failed", true],
          ["failed", true],
          ["failed", true],
        ],
      );
      assert.deepEqual(errorMessages(projection), [REFUSAL, REFUSAL, REFUSAL]);
      assert.deepEqual(yield* Ref.get(calls), before);
    }),
  ),
);

// Live: the effect worker retries an in-use refusal on its wall-clock backoff before the run fails.
it.live("hands a thread out by releasing its session, and takes it back once", () =>
  withThread("native-session-handout", ({ threadId, calls, out, send }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const handout = yield* handoutFor(out);
      const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
        .providerThreads[0]!.providerSessionId!;

      // The send may land before the hand-out (which then waits for it) or after (refused).
      const racing = yield* send("racing").pipe(Effect.forkScoped);
      const handedOut = yield* Effect.result(handout.handOut(threadId));
      yield* Fiber.join(racing);
      if (handedOut._tag === "Failure") {
        assert.equal(handedOut.failure.reason, "busy");
        yield* handout.handOut(threadId);
      }
      assert.isFalse(yield* sessions.isLive(providerSessionId));
      assert.isDefined(yield* out.get(threadId));
      yield* send("while out");
      assert.equal((yield* Ref.get(calls)).opens, 1);

      yield* handout.takeBack(threadId);
      yield* handout.takeBack(threadId);
      assert.isUndefined(yield* out.get(threadId));
      const back = yield* orchestrator.getThreadProjection(threadId);
      const notices = back.turnItems.flatMap((item, index) =>
        item.type === "system_notice" ? [{ message: item.message, level: item.level, index }] : [],
      );
      assert.deepEqual(
        notices.map(({ message, level }) => ({ message, level })),
        [{ message: takeBackNotice(driver), level: "info" }],
      );
      assert.equal(notices[0]!.index, back.turnItems.length - 1);
      assert.equal(
        (yield* out.getTakeBack(threadId))?.takenBackAt,
        DateTime.formatIso(back.turnItems.at(-1)!.startedAt!),
      );

      yield* send("back");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.at(-1)?.status, "completed");
      assert.equal((yield* Ref.get(calls)).opens, 2);
    }),
  ),
);

it.effect("takes back a deleted thread by clearing its mark", () =>
  withThread("native-session-deleted", ({ threadId, out }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const handout = yield* handoutFor(out);
      yield* handout.handOut(threadId);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:native-session-deleted:delete"),
        threadId,
      });

      yield* handout.takeBack(threadId);
      assert.isUndefined(yield* out.get(threadId));
      assert.isUndefined(yield* out.getTakeBack(threadId));
    }),
  ),
);

const sibling = ThreadId.make("thread:native-session-sibling");

it.effect("hands out one thread of a shared process by detaching it", () =>
  withThread(
    "native-session-shared",
    ({ threadId, calls, out, send, cwd }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const handout = yield* handoutFor(out);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:native-session-sibling:create"),
          threadId: sibling,
          projectId: ProjectId.make("project:native-session-shared"),
          title: "sibling",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:native-session-sibling:work"),
          threadId: sibling,
          messageId: MessageId.make("message:native-session-sibling:work"),
          text: "work",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* worker.drain();
        const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!.providerSessionId!;
        const siblingThread = (yield* orchestrator.getThreadProjection(sibling)).providerThreads[0];
        assert.equal(siblingThread?.providerSessionId, providerSessionId);
        assert.equal((yield* orchestrator.getThreadProjection(sibling)).runs[0]?.status, "running");

        yield* handout.handOut(threadId);
        // Releasing would have refused as busy: the sibling's turn is still running.
        assert.isTrue(yield* sessions.isLive(providerSessionId));

        yield* handout.takeBack(threadId);
        const before = yield* Ref.get(calls);
        yield* send("back");
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
          "completed",
        );
        assert.deepEqual(yield* Ref.get(calls), {
          ...before,
          resumes: before.resumes + 1,
          starts: before.starts + 1,
        });
      }),
    sibling,
  ),
);
