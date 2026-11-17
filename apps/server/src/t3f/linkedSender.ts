import { parseGoalCommand, type OrchestrationV2LinkedSender } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isNativeMaintenanceCommand } from "../orchestration-v2/CommandPolicy.ts";
import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import type { Caller } from "../mcp/threadAccess.ts";
import type * as PeerLinks from "../peer/PeerLinks.ts";

const TITLE_LIMIT = 200;
const NOT_THE_USER = "This is agent-authored coordination, not a message from the human user.";

/**
 * Puts the sender line where a command delivery runs keeps its token first: the line goes
 * into the free text of `/compact <text>` and `/goal <objective>`, and a bare control
 * command stays as it is. Attachments make the whole message plain text.
 */
const placeLine = (line: string, text: string, attachments: number): string => {
  if (attachments === 0) {
    if (isNativeMaintenanceCommand({ text, attachments: [] })) return text;
    const goal = parseGoalCommand({ text });
    if (goal !== null) return goal.type === "set" ? `/goal ${line}\n\n${goal.objective}` : text;
    const compact = /^\/compact\s+([\s\S]+)$/u.exec(text.trim());
    if (compact?.[1] !== undefined) return `/compact ${line}\n\n${compact[1].trim()}`;
  }
  return text.length === 0 ? line : `${line}\n\n${text}`;
};

/**
 * The line for a linked environment's agent that passed its thread. The thread lives on
 * another machine, so the line also gives the environment id, which a reply through the
 * links tool needs, and the title as the readable handle.
 */
const linkedSenderLine = (
  sender: OrchestrationV2LinkedSender,
  label?: string | undefined,
): string => {
  const environment =
    label === undefined ? " a linked environment" : ` linked environment ${JSON.stringify(label)}`;
  const title = [...sender.title].slice(0, TITLE_LIMIT).join("");
  const titled = title.length === 0 ? "" : `, titled ${JSON.stringify(title)}`;
  return `[Message from an agent on${environment} (environment ${JSON.stringify(sender.environmentId)}, thread ${JSON.stringify(sender.threadId)}${titled}). ${NOT_THE_USER}]`;
};

/** The text a provider receives for a message with a recorded linked sender. */
export const withLinkedSender = (
  sender: OrchestrationV2LinkedSender | undefined,
  text: string,
  attachments: number,
  label?: string | undefined,
): string =>
  sender === undefined ? text : placeLine(linkedSenderLine(sender, label), text, attachments);

/** The name this environment gave a linked environment, if it has a link to it. A failed lookup names nothing. */
export const linkedEnvironmentLabel = (
  peerLinks: PeerLinks.PeerLinks["Service"],
  sender: OrchestrationV2LinkedSender,
) =>
  peerLinks.get(sender.environmentId).pipe(
    Effect.map(
      Option.match({
        onNone: () => undefined,
        onSome: (link) => (link.label.length === 0 ? undefined : link.label),
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );

/** `withLinkedSender` with the label looked up, for the two points that hand a message to a provider. */
export const withLinkedSenderAtDelivery = Effect.fn("t3f.withLinkedSenderAtDelivery")(function* (
  peerLinks: PeerLinks.PeerLinks["Service"],
  message: { readonly linkedSender?: OrchestrationV2LinkedSender | undefined },
  text: string,
  attachments: number,
) {
  if (message.linkedSender === undefined) return text;
  const label = yield* linkedEnvironmentLabel(peerLinks, message.linkedSender);
  return withLinkedSender(message.linkedSender, text, attachments, label);
});

/** The sender thread a linked environment's agent passed, for the sites that record it. */
export const linkedSenderRecord = ({
  scope,
  caller,
}: Pick<Caller, "scope"> & { readonly caller: object | undefined }) =>
  caller === undefined && scope.client?.senderThread !== undefined
    ? { linkedSender: scope.client.senderThread }
    : {};

/**
 * A message from a linked environment's agent with no thread here and no recorded sender
 * thread (an older machine, or a thread launch, which carries no record) has no sender to
 * name, so its text says which link it came from. A site that records the sender thread says so.
 */
export const withLinkedSenderLine = (
  { scope, caller }: Pick<Caller, "scope"> & { readonly caller: object | undefined },
  text: string,
  attachments = 0,
  recordsSender = false,
): string => {
  const origin = caller === undefined ? callerLinkOrigin({ scope, caller }) : undefined;
  if (origin === undefined || (recordsSender && scope.client?.senderThread !== undefined))
    return text;
  const from = origin.label.length === 0 ? "" : ` ${JSON.stringify(origin.label)}`;
  return placeLine(
    `[Message from an agent on linked environment${from}. ${NOT_THE_USER}]`,
    text,
    attachments,
  );
};
