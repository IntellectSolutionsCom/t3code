import {
  linkOriginIsFenced,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadSendInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { assertSameLink } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { assertTargetWithinLimits, type Caller } from "../mcp/threadAccess.ts";
import * as LinkMessageGrants from "./LinkMessageGrants.ts";

/**
 * A linked environment's agent calling directly, below full access, may send messages here once the
 * user allowed it in Connections. Agents in threads the link started here are not covered. Absent the
 * service, nothing is granted.
 */
export const grantedLinkSession = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const client = scope.client;
  if (scope.thread !== undefined || client?.linked !== true || !linkOriginIsFenced(client)) {
    return undefined;
  }
  const grants = yield* Effect.serviceOption(LinkMessageGrants.LinkMessageGrants);
  if (Option.isNone(grants)) return undefined;
  yield* grants.value.recordLink(client.sessionId);
  return (yield* grants.value.isGranted(client.sessionId)) ? client.sessionId : undefined;
}).pipe(Effect.withSpan("LinkMessageGrant.grantedLinkSession"));

/**
 * Upstream's checks decide first, so a link keeps every right it has on its own threads. The grant
 * covers what they refuse: a read-only link, a thread above the link's modes, another link's thread.
 */
export const grantCovers = (
  caller: Pick<Caller, "scope" | "caller" | "limits">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin" | "runtimeMode" | "interactionMode">,
) =>
  caller.scope.client?.access === "read-only"
    ? Effect.succeed(true)
    : Effect.isFailure(
        assertTargetWithinLimits(caller.limits, target).pipe(
          Effect.andThen(assertSameLink(caller, target)),
        ),
      );

/** Set only on a granted link's send: it skips the caller's mode limits for the target thread's own. */
export const LinkGrantedSend = Context.Reference<boolean>("t3/t3f/LinkGrantedSend", {
  defaultValue: () => false,
});

const refused = (message: string) =>
  Effect.fail(
    new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `${message} A linked environment allowed to send messages here may only queue plain messages.`,
    }),
  );

/** A leading `/token` the thread would run as a command; a multi-segment path such as `/home/a.ts` is text. */
const COMMAND_PATTERN = /^\/[^\s/]+(?:\s|$)/u;

/** A granted send never interrupts a running turn, clears context, or runs a command. */
export const grantedSendMode = (
  input: Pick<OrchestratorMcpThreadSendInput, "mode" | "freshContext" | "message">,
) => {
  if (input.mode === "steer" || input.mode === "restart") {
    return refused(`Mode ${input.mode} acts on the running turn.`);
  }
  if (input.freshContext === true) return refused("freshContext clears the thread's context.");
  if (COMMAND_PATTERN.test(input.message.trim())) return refused("The message is a command.");
  return Effect.succeed("queue" as const);
};
