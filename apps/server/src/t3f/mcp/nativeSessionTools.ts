import {
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  T3fNativeSessionAdoptResult,
  T3fNativeSessionIdentifyResult,
  T3fNativeSessionListResult,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as NativeSessions from "../NativeSessions.ts";

const NativeSessionTool = Tool.make("t3_native_session", {
  description:
    "Provider sessions behind threads. `identify`: a thread's provider, native session id, the name its own client shows, folder, and a terminal command that continues it there (null with `commandNote` where not yet verified); omit `threadId` for this thread; `session` is null before the first turn. `list`: sessions that ran in a project's folder, including ones started outside T3 Code; `threadId` is the thread already on one. `adopt`: loads a listed session (`providerInstanceId`, `nativeId`) into a new thread, or returns the thread already on it. `projectId` defaults to this thread's project.",
  parameters: Schema.Struct({
    action: Schema.Literals(["identify", "list", "adopt"]),
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
    providerInstanceId: Schema.optional(ProviderInstanceId),
    nativeId: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    T3fNativeSessionIdentifyResult,
    T3fNativeSessionListResult,
    T3fNativeSessionAdoptResult,
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    NativeSessions.NativeSessions,
  ],
})
  .annotate(Tool.Title, "Native provider sessions")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const NativeSessionToolkit = Toolkit.make(NativeSessionTool);
