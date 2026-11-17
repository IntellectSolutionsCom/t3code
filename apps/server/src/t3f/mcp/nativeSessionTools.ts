import {
  OrchestratorMcpFailure,
  T3fNativeSessionIdentifyResult,
  ThreadId,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as NativeSessions from "../NativeSessions.ts";

const NativeSessionTool = Tool.make("t3_native_session", {
  description:
    "A thread's own provider session. `identify`: provider, native session id, the name the provider's own client shows, folder, and a terminal command that continues the session in that client (null with `commandNote` where not yet verified). Omit `threadId` for this thread. `session` is null before the first turn.",
  parameters: Schema.Struct({
    action: Schema.Literal("identify"),
    threadId: Schema.optional(ThreadId),
  }),
  success: T3fNativeSessionIdentifyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    NativeSessions.NativeSessions,
  ],
})
  .annotate(Tool.Title, "Identify a thread's native session")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const NativeSessionToolkit = Toolkit.make(NativeSessionTool);
