import {
  OrchestratorMcpFailure,
  T3fThreadBadge,
  ThreadId,
  type T3fThreadBadgeError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { readThread, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadBadges from "./ThreadBadges.ts";

const ThreadBadgeTool = Tool.make("t3_thread_badge", {
  description:
    "Read, set or clear a thread's badge: one emoji `symbol` and a short `label` shown beside its title. Omit `threadId` for this thread. `set` needs both. Leave a badge the user set unless asked.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals(["read", "set", "clear"]),
    symbol: Schema.optional(Schema.String),
    label: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ threadId: ThreadId, badge: Schema.NullOr(T3fThreadBadge) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadBadges.ThreadBadges,
  ],
}).annotate(Tool.Title, "Badge a thread");

export const ThreadBadgeToolkit = Toolkit.make(ThreadBadgeTool);

const badgeFailure = (error: T3fThreadBadgeError) =>
  error.reason === "storage"
    ? unavailable()
    : new OrchestratorMcpFailure({
        code: error.reason === "thread_not_found" ? "thread_not_found" : "invalid_request",
        message: error.message,
      });

const needs = (name: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `This action needs \`${name}\`.`,
  });

export const layer = McpToolAccess.toLayer(ThreadBadgeToolkit, {
  t3_thread_badge: McpToolAccess.either(
    (input) => input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const badges = yield* ThreadBadges.ThreadBadges;
        const badge = yield* badges.get(projection.thread.id).pipe(Effect.mapError(badgeFailure));
        return { threadId: projection.thread.id, badge };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const requested =
            input.action === "clear"
              ? null
              : {
                  symbol: input.symbol ?? (yield* needs("symbol")),
                  label: input.label ?? (yield* needs("label")),
                };
          const { projection } = yield* readThread(input.threadId);
          const badges = yield* ThreadBadges.ThreadBadges;
          const badge = yield* badges
            .set(projection.thread.id, requested)
            .pipe(Effect.mapError(badgeFailure));
          return { threadId: projection.thread.id, badge };
        }),
    ),
  ),
});
