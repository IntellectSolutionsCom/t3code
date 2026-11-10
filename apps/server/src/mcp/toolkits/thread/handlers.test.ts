import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "mcp-queue-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerTest = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provideMerge(
    ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    ),
  ),
);

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-queue-hold"),
  requestNamespace: "client:queue-hold",
  thread: undefined,
  client: { sessionId: "queue-hold", label: "Dispatcher", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-queue-hold", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-queue-hold", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const queue = (args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_queue", arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

interface Author {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
}
const agent: Author = { createdBy: "agent", creationSource: "mcp" };
const person: Author = { createdBy: "user", creationSource: "web" };
const personsTask: Author = {
  createdBy: "user",
  creationSource: "server",
  scheduledTaskId: ScheduledTaskId.make("task:queue-hold"),
};

const runUpdated = (run: OrchestrationV2Run, payload: Partial<OrchestrationV2Run>) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make(`event:${run.id}:${payload.status ?? "held"}`),
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      occurredAt: yield* DateTime.now,
      payload: { ...run, ...payload },
    });
  });

/**
 * Run 1 starts and two later messages queue behind it. Then a real Stop holds the queue, or
 * run 1 fails and the queue is held as the orchestrator holds it after a provider failure.
 */
const heldThread = (
  threadId: ThreadId,
  options: {
    readonly authors?: readonly [Author, Author];
    readonly stop?: boolean;
    readonly failure?: Partial<OrchestrationV2Run>;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const send = (text: string, author: Author, type: "start_immediately" | "queue_after_active") =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}:${text}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type },
        ...author,
      });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:mcp-queue-hold"),
      title: threadId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const [firstAuthor, secondAuthor] = options.authors ?? [agent, agent];
    yield* send("first", agent, "start_immediately");
    yield* send("second", firstAuthor, "queue_after_active");
    yield* send("third", secondAuthor, "queue_after_active");
    const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const [first, ...queued] = runs as [OrchestrationV2Run, ...OrchestrationV2Run[]];
    if (options.stop === true) {
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop:${threadId}`),
        threadId,
      });
      return { first, queued };
    }
    const now = yield* DateTime.now;
    yield* runUpdated(first, {
      status: "failed",
      startedAt: now,
      completedAt: now,
      ...options.failure,
    });
    for (const run of queued) yield* runUpdated(run, { queueHeld: true });
    return { first, queued };
  });

const threadRuns = (threadId: ThreadId, ids: ReadonlyArray<OrchestrationV2Run>) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(threadId)),
    Effect.map(({ runs }) => ids.map((run) => runs.find((candidate) => candidate.id === run.id)!)),
  );

const refusal = {
  code: "invalid_request",
  message: "This held queue waits for the user. Tell the user.",
};

it.layer(layerTest)("t3_queue held queues", (it) => {
  it.effect("lists the hold and resumes it so the next run starts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:queue-hold");
      const { queued } = yield* heldThread(threadId);

      const held = yield* queue({ action: "list", threadId });
      assert.deepEqual(held.structuredContent, {
        held: true,
        items: queued.map((run, index) => ({
          queuedRunId: run.id,
          text: index === 0 ? "second" : "third",
          truncated: false,
          held: true,
        })),
        nextCursor: null,
      });

      const resumed = yield* queue({ action: "resume", threadId });
      assert.isUndefined(declaredFailure(resumed));
      assert.deepEqual(
        (yield* threadRuns(threadId, queued)).map((run) => run.status),
        ["starting", "queued"],
      );
      const after = yield* queue({ action: "list", threadId });
      assert.deepEqual(after.structuredContent, {
        held: false,
        items: [{ queuedRunId: queued[1]!.id, text: "third", truncated: false, held: false }],
        nextCursor: null,
      });
    }),
  );

  it.effect.each([
    { name: "a person's web messages", authors: [person, person] as const },
    { name: "a person's scheduled task", authors: [personsTask, personsTask] as const },
    { name: "one person's message among an agent's", authors: [agent, person] as const },
  ])("refuses to resume while it holds $name", ({ name, authors }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:queue-hold:${name}`);
      const { queued } = yield* heldThread(threadId, { authors });
      assert.deepInclude(declaredFailure(yield* queue({ action: "resume", threadId })), refusal);
      assert.deepEqual(
        (yield* threadRuns(threadId, queued)).map((run) => run.queueHeld),
        [true, true],
      );
    }),
  );

  it.effect("refuses to resume after a Stop", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:queue-hold-stop");
      const { first, queued } = yield* heldThread(threadId, { stop: true });
      const { runs, turnItems } = yield* projections.getThreadRecords(
        threadId,
        ["runs", "turnItems"],
        { turnItemTypes: ["run_interrupt_request"] },
      );
      assert.equal(latestExecutedRun(runs)?.id, first.id);
      assert.deepEqual(
        turnItems.map((item) => item.runId),
        [first.id],
      );

      assert.deepInclude(declaredFailure(yield* queue({ action: "resume", threadId })), refusal);
      assert.deepEqual(
        (yield* threadRuns(threadId, queued)).map((run) => run.queueHeld),
        [true, true],
      );
    }),
  );

  it.effect("refuses to resume after a failed worktree setup", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:queue-hold-worktree");
      const { queued } = yield* heldThread(threadId, {
        failure: { workspacePreparation: { type: "worktree", baseRef: "main" } },
      });
      assert.deepInclude(declaredFailure(yield* queue({ action: "resume", threadId })), refusal);
      assert.deepEqual(
        (yield* threadRuns(threadId, queued)).map((run) => run.queueHeld),
        [true, true],
      );
    }),
  );

  // The hold's cause is read from the newest executed run: a Stop's mark on an older run does
  // not keep a later provider failure's hold from an agent.
  it.effect("resumes when a later run failed after an earlier Stop", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:queue-hold-stop-then-failure");
      const { first, queued } = yield* heldThread(threadId, { stop: true });
      const [stopped] = yield* threadRuns(threadId, [first]);
      if (stopped!.completedAt == null) {
        yield* runUpdated(stopped!, { status: "interrupted", completedAt: yield* DateTime.now });
      }
      yield* TestClock.adjust("1 second");
      const now = yield* DateTime.now;
      const [failing] = yield* threadRuns(threadId, [queued[0]!]);
      yield* runUpdated(failing!, {
        status: "failed",
        queueHeld: false,
        startedAt: now,
        completedAt: now,
      });

      assert.isUndefined(declaredFailure(yield* queue({ action: "resume", threadId })));
      const [next] = yield* threadRuns(threadId, [queued[1]!]);
      assert.equal(next!.status, "starting");
      assert.notEqual(next!.queueHeld, true);
    }),
  );
});
