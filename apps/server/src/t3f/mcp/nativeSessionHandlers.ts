import {
  OrchestratorMcpFailure,
  type ProjectId,
  type T3fNativeSessionError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { assertNotLinked } from "../../mcp/linkOrigin.ts";
import { loadCaller, readThread, unavailable } from "../../mcp/threadAccess.ts";
import * as NativeSessions from "../NativeSessions.ts";
import { NativeSessionToolkit } from "./nativeSessionTools.ts";

const toMcpFailure = (error: T3fNativeSessionError) => {
  switch (error.reason) {
    case "thread_not_found":
      return new OrchestratorMcpFailure({ code: "thread_not_found", message: error.message });
    case "instance_not_found":
      return new OrchestratorMcpFailure({ code: "provider_unavailable", message: error.message });
    case "storage":
      return unavailable();
    default:
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
  }
};

const projectOf = (projectId: ProjectId | undefined, threadId: ThreadId | undefined) =>
  projectId === undefined
    ? readThread(threadId).pipe(Effect.map(({ projection }) => projection.thread.projectId))
    : Effect.succeed(projectId);

const handlers = {
  t3_native_session: McpToolAccess.either(
    (input) => input.action === "identify" || input.action === "list",
    McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const sessions = yield* NativeSessions.NativeSessions;
        if (input.action === "list") {
          const projectId = yield* projectOf(input.projectId, input.threadId);
          return yield* sessions.list(projectId).pipe(Effect.mapError(toMcpFailure));
        }
        const {
          projection: { thread },
        } = yield* readThread(input.threadId);
        return yield* sessions.identify(thread.id).pipe(Effect.mapError(toMcpFailure));
      }),
    ),
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const sessions = yield* NativeSessions.NativeSessions;
        yield* assertNotLinked(
          yield* loadCaller(),
          input.action === "adopt"
            ? "start work here that is not its link's"
            : "hand a thread's session out or take it back",
        );
        if (input.action === "hand_out" || input.action === "take_back") {
          const {
            projection: { thread },
          } = yield* readThread(input.threadId);
          return input.action === "hand_out"
            ? yield* sessions.handOut(thread.id).pipe(Effect.mapError(toMcpFailure))
            : yield* sessions
                .takeBack(thread.id)
                .pipe(Effect.as({}), Effect.mapError(toMcpFailure));
        }
        if (input.providerInstanceId === undefined || input.nativeId === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "`adopt` needs `providerInstanceId` and `nativeId`, as `list` gives them.",
          });
        }
        const projectId = yield* projectOf(input.projectId, input.threadId);
        return yield* sessions
          .adopt({
            projectId,
            providerInstanceId: input.providerInstanceId,
            nativeId: input.nativeId,
          })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof NativeSessionToolkit.tools>;

export const layer = McpToolAccess.toLayer(NativeSessionToolkit, handlers);
