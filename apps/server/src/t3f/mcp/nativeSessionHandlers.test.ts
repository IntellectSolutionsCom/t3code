import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as NativeSessions from "../NativeSessions.ts";
import * as NativeSessionHandlers from "./nativeSessionHandlers.ts";
import { NativeSessionToolkit } from "./nativeSessionTools.ts";

const outsideClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

// Discovery hides the tool from outside clients; the call must be refused as well.
it.effect.each(["identify", "list", "adopt", "hand_out", "take_back"] as const)(
  "refuses an outside client to %s",
  (action) =>
    Effect.gen(function* () {
      const built = yield* NativeSessionToolkit;
      const { result } = yield* built
        .handle("t3_native_session", {
          action,
          threadId: ThreadId.make("thread-1"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          nativeId: "session-1",
        })
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
      expect(result).toMatchObject({ code: "thread_credential_required" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpToolAccess.HandlersLayer.layer(NativeSessionHandlers.layer),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(NativeSessions.NativeSessions)({}),
        ),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, outsideClient),
    ),
);

// A thread a link started below full access acts for that link, which may not hand sessions out.
const fencedThread = ThreadId.make("thread:started-by-fenced-link");
const fencedAgent: McpInvocationContext.McpInvocationScope = {
  ...outsideClient,
  client: undefined,
  thread: {
    threadId: fencedThread,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

it.effect.each(["hand_out", "take_back"] as const)(
  "refuses an agent working for a fenced link to %s",
  (action) =>
    Effect.gen(function* () {
      const built = yield* NativeSessionToolkit;
      const { result } = yield* built
        .handle("t3_native_session", { action, threadId: fencedThread })
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
      expect(result).toMatchObject({ code: "capability_denied" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpToolAccess.HandlersLayer.layer(NativeSessionHandlers.layer),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed({
                ...liveThreadShell(threadId),
                linkOrigin: { sessionId: "peer-session", label: "Laptop", access: "auto" },
              }),
          }),
          Layer.mock(NativeSessions.NativeSessions)({
            handOut: () => Effect.die("handed out for a fenced link"),
            takeBack: () => Effect.die("taken back for a fenced link"),
          }),
        ),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, fencedAgent),
    ),
);
