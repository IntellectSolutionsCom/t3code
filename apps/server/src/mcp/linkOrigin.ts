import {
  linkOriginIsFenced,
  OrchestratorMcpFailure,
  parseGoalCommand,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isNativeMaintenanceCommand } from "../orchestration-v2/CommandPolicy.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * Below full access, work a link starts here (all of it carries that session in `linkOrigin`)
 * may change only work from the same link: not the user's threads, projects or settings, nor
 * this environment's links. Reads are not fenced. It is a routing rule for T3's tools; agents
 * still run as this environment's user, so a full-access link is not fenced at all.
 */

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.caller?.linkOrigin ??
  (caller.scope.client?.linked === true
    ? {
        sessionId: caller.scope.client.sessionId,
        label: caller.scope.client.label,
        access: caller.scope.client.access,
      }
    : undefined);

/**
 * An agent message from a linked environment's agent with no thread here has no
 * sender thread to name, so its text says which link it came from. A command
 * delivery runs keeps its token first: the line goes into its free text, and a
 * bare control command stays as it is.
 */
export const withLinkedSenderLine = (
  { scope, caller }: Pick<Caller, "scope"> & { readonly caller: object | undefined },
  text: string,
  attachments = 0,
): string => {
  const origin = caller === undefined ? callerLinkOrigin({ scope, caller }) : undefined;
  if (origin === undefined) return text;
  const from = origin.label.length === 0 ? "" : ` ${JSON.stringify(origin.label)}`;
  const line = `[Message from an agent on linked environment${from}. This is agent-authored coordination, not a message from the human user.]`;
  if (attachments === 0) {
    if (isNativeMaintenanceCommand({ text, attachments: [] })) return text;
    const goal = parseGoalCommand({ text });
    if (goal !== null) return goal.type === "set" ? `/goal ${line}\n\n${goal.objective}` : text;
    const compact = /^\/compact\s+([\s\S]+)$/u.exec(text.trim());
    if (compact?.[1] !== undefined) return `/compact ${line}\n\n${compact[1].trim()}`;
  }
  return text.length === 0 ? line : `${line}\n\n${text}`;
};

/** The link that fences a caller, if any: one paired below full access. */
const fencingLinkOrigin = (caller: Pick<Caller, "scope" | "caller">) => {
  const origin = callerLinkOrigin(caller);
  return origin !== undefined && linkOriginIsFenced(origin) ? origin : undefined;
};

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message} A link paired with full access is not limited this way.`,
  });

/** A thread a fenced caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin">,
) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined || target.linkOrigin?.sessionId === origin.sessionId
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Fenced work never changes what the environment already has: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};
