import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadBadges from "./ThreadBadges.ts";
import * as ThreadBadgeTools from "./threadBadgeToolkit.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:thread-badge");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Badges never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-badge" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerThreads = ThreadManagement.layer.pipe(
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
);
const layerTest = McpHttpServer.toolkitRegistration(
  ThreadBadgeTools.ThreadBadgeToolkit,
  ThreadBadgeTools.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(ThreadBadges.layer.pipe(Layer.provideMerge(layerThreads))),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-badge", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-badge", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const clientScope = (
  sessionId: string,
  access: McpInvocationContext.McpClientCaller["access"],
  linked: boolean,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:badges"),
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: { sessionId, label: `T3 Code · ${sessionId}`, access, linked },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const agent = clientScope("agent", "full-access", false);
const laptop = clientScope("laptop", "auto", true);
const reader = clientScope("reader", "read-only", false);

const badge = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_thread_badge", arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );
const failureCode = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { code: string }).code
    : undefined;
};

const createThread = (id: string, linkSession?: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(id);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId,
      projectId,
      title: id,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(linkSession === undefined
        ? {}
        : {
            linkOrigin: {
              sessionId: linkSession,
              label: `T3 Code · ${linkSession}`,
              access: "auto",
            },
          }),
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const rocket = { symbol: "🚀", label: "Launch" };

it.layer(layerTest)("t3_thread_badge", (it) => {
  it.effect("an agent sets, reads and clears a thread's badge", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("thread:badged");
      const set = yield* badge(agent, { threadId, action: "set", ...rocket });
      assert.deepEqual(set.structuredContent, { threadId, badge: rocket });
      assert.deepEqual((yield* badge(agent, { threadId, action: "read" })).structuredContent, {
        threadId,
        badge: rocket,
      });
      const cleared = yield* badge(agent, { threadId, action: "clear" });
      assert.deepEqual(cleared.structuredContent, { threadId, badge: null });
      assert.deepEqual((yield* badge(agent, { threadId, action: "read" })).structuredContent, {
        threadId,
        badge: null,
      });
    }),
  );

  it.effect("refuses a bad symbol or label, a missing field and an unknown thread", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("thread:refused");
      assert.equal(
        failureCode(yield* badge(agent, { threadId, action: "set", symbol: "x", label: "Label" })),
        "invalid_request",
      );
      assert.equal(
        failureCode(yield* badge(agent, { threadId, action: "set", symbol: "🚀", label: " " })),
        "invalid_request",
      );
      assert.equal(
        failureCode(yield* badge(agent, { threadId, action: "set", symbol: "🚀" })),
        "invalid_request",
      );
      assert.equal(
        failureCode(yield* badge(agent, { threadId: "thread:nowhere", action: "set", ...rocket })),
        "thread_not_found",
      );
    }),
  );

  it.effect("a link below full access badges only the threads it started, and may read any", () =>
    Effect.gen(function* () {
      const users = yield* createThread("thread:users-own");
      const started = yield* createThread("thread:started-by-laptop", "laptop");
      yield* badge(agent, { threadId: users, action: "set", ...rocket });

      assert.equal(
        failureCode(yield* badge(laptop, { threadId: users, action: "clear" })),
        "capability_denied",
      );
      assert.equal(
        failureCode(yield* badge(laptop, { threadId: users, action: "set", ...rocket })),
        "capability_denied",
      );
      assert.deepEqual(
        (yield* badge(laptop, { threadId: users, action: "read" })).structuredContent,
        {
          threadId: users,
          badge: rocket,
        },
      );
      assert.deepEqual(
        (yield* badge(laptop, { threadId: started, action: "set", ...rocket })).structuredContent,
        { threadId: started, badge: rocket },
      );
    }),
  );

  it.effect("a read-only client reads but cannot change a badge", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("thread:read-only");
      assert.equal(
        failureCode(yield* badge(reader, { threadId, action: "set", ...rocket })),
        "capability_denied",
      );
      assert.equal((yield* badge(reader, { threadId, action: "read" })).isError, false);
    }),
  );
});
