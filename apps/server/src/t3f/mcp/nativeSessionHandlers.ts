import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readThread, unavailable } from "../../mcp/threadAccess.ts";
import * as NativeSessions from "../NativeSessions.ts";
import { NativeSessionToolkit } from "./nativeSessionTools.ts";

const handlers = {
  t3_native_session: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const sessions = yield* NativeSessions.NativeSessions;
      return yield* sessions
        .identify(thread.id)
        .pipe(
          Effect.mapError((error) =>
            error.reason === "thread_not_found"
              ? new OrchestratorMcpFailure({ code: "thread_not_found", message: error.message })
              : unavailable(),
          ),
        );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof NativeSessionToolkit.tools>;

export const layer = McpToolAccess.toLayer(NativeSessionToolkit, handlers);
