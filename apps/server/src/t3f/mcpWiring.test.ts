import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../mcp/ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkMessageGrant from "./linkMessageGrant.ts";
import * as LinkMessageGrants from "./LinkMessageGrants.ts";

const environmentId = EnvironmentId.make("environment-grant-wiring");
const threadId = ThreadId.make("thread-grant-wiring");

const layerState = LinkMessageGrants.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer)),
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3f-grant-wiring-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("a granted link's t3_thread_send reaches the grant through /mcp", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const grants = yield* LinkMessageGrants.LinkMessageGrants;
      const link = yield* auth.issueMcpClientSession({
        label: "T3 Code · laptop",
        access: "read-only",
        peerLink: true,
        client: { deviceType: "bot" },
      });
      const sentAsGranted: Array<boolean> = [];
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(
          McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
        ).pipe(
          Layer.provide(
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
              sendToThread: (_scope, input) =>
                LinkMessageGrant.LinkGrantedSend.pipe(
                  Effect.map((granted) => {
                    sentAsGranted.push(granted);
                    return {
                      threadId: input.threadId,
                      link: "t3://thread",
                      messageId: MessageId.make("message-1"),
                      runId: RunId.make("run-1"),
                      status: "running",
                      delivery: "queued",
                    } as const;
                  }),
                ),
            }),
          ),
          Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(McpOAuth.layerMcpClientAuthenticator),
          Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);

      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${link.token}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"link","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const send = httpClient
        .post("/mcp", {
          headers: {
            ...headers,
            "mcp-session-id": initialize.headers["mcp-session-id"]!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "t3_thread_send",
                arguments: { threadId, message: "Check the build" },
              },
            }),
            "application/json",
          ),
        })
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { result: { isError?: boolean } }).result),
        );

      expect(yield* send).toMatchObject({ isError: true });
      yield* grants.set(
        { sessionId: link.sessionId, granted: true },
        AuthSessionId.make("browser-session"),
      );
      expect((yield* send).isError).not.toBe(true);
      expect(sentAsGranted).toEqual([true]);
    }),
  ).pipe(Effect.provide(layerState.pipe(Layer.provideMerge(NodeHttpServer.layerTest)))),
);
