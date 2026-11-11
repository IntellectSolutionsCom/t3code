import { MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "~/hooks/useLocalStorage";
import { toastManager } from "../ui/toast";

export const MAX_PINNED_MESSAGES = 50;
export const PINNED_MESSAGE_LABEL_MAX_LENGTH = 160;

/** Environment and thread live in the storage key, so a record moves with them unchanged. */
export const PinnedMessage = Schema.Struct({
  messageId: MessageId,
  label: Schema.String,
  pinnedAt: Schema.String,
});
export type PinnedMessage = typeof PinnedMessage.Type;
export const PinnedMessages = Schema.Array(PinnedMessage);
const StoredPinnedMessages = Schema.NullOr(PinnedMessages);

const NO_PINS: ReadonlyArray<PinnedMessage> = [];

/** One key per thread, so an unreadable entry empties only its own thread's pins. */
function pinnedMessagesStorageKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `t3code:pins:v1:${environmentId}:${threadId}`;
}

function pinnedMessageLabel(text: string) {
  const label = text.replace(/\s+/g, " ").trim().slice(0, PINNED_MESSAGE_LABEL_MAX_LENGTH);
  return /[\uD800-\uDBFF]$/.test(label) ? label.slice(0, -1) : label;
}

/** Unchanged when the message is already pinned or the thread is at the cap. */
export function pinMessage(
  pins: ReadonlyArray<PinnedMessage>,
  pin: PinnedMessage,
): ReadonlyArray<PinnedMessage> {
  if (pins.length >= MAX_PINNED_MESSAGES || pins.some((p) => p.messageId === pin.messageId)) {
    return pins;
  }
  return [...pins, { ...pin, label: pinnedMessageLabel(pin.label) }];
}

export function unpinMessage(
  pins: ReadonlyArray<PinnedMessage>,
  messageId: MessageId,
): ReadonlyArray<PinnedMessage> {
  return pins.some((p) => p.messageId === messageId)
    ? pins.filter((p) => p.messageId !== messageId)
    : pins;
}

export function newestPinsFirst(pins: ReadonlyArray<PinnedMessage>) {
  return pins.toSorted((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
}

/** The pin the bar shows: the cursor's, or the newest when the cursor is gone. */
export function pinnedMessageBar(pins: ReadonlyArray<PinnedMessage>, cursor: MessageId | null) {
  const ordered = newestPinsFirst(pins);
  const index = Math.max(
    0,
    ordered.findIndex((p) => p.messageId === cursor),
  );
  const pin = ordered[index];
  return pin ? { pin, position: index + 1, total: ordered.length } : null;
}

/** The next older pin after `current`, wrapping to the newest; null when there is no other. */
export function nextPinnedMessageId(
  pins: ReadonlyArray<PinnedMessage>,
  current: MessageId,
): MessageId | null {
  const ordered = newestPinsFirst(pins);
  if (ordered.length < 2) return null;
  const index = ordered.findIndex((p) => p.messageId === current);
  return ordered[(index + 1) % ordered.length]!.messageId;
}

export interface PinnedMessageBarState {
  readonly cursor: MessageId | null;
  /** The newest pin time seen, so a pin added later takes the bar. */
  readonly newestPinnedAt: string;
  /** Pins whose jump found the message gone, kept for this thread view. */
  readonly gone: ReadonlySet<MessageId>;
  readonly goneReportKey: string | null;
}

const newestPinnedAt = (pins: ReadonlyArray<PinnedMessage>) =>
  pins.reduce((newest, pin) => (pin.pinnedAt > newest ? pin.pinnedAt : newest), "");

export function initialPinnedMessageBarState(
  pins: ReadonlyArray<PinnedMessage>,
): PinnedMessageBarState {
  return {
    cursor: null,
    newestPinnedAt: newestPinnedAt(pins),
    gone: new Set(),
    goneReportKey: null,
  };
}

/** Same state back when nothing changed, so the bar can adjust it during render. */
export function reconcilePinnedMessageBar(
  state: PinnedMessageBarState,
  pins: ReadonlyArray<PinnedMessage>,
  reportedGone: { readonly key: string; readonly messageId: MessageId } | null,
): PinnedMessageBarState {
  let next = state;
  const newest = newestPinnedAt(pins);
  if (newest > next.newestPinnedAt) {
    const added = pins.find((pin) => pin.pinnedAt === newest)!;
    next = { ...next, cursor: added.messageId, newestPinnedAt: newest };
  }
  if (reportedGone !== null && reportedGone.key !== next.goneReportKey) {
    next = {
      ...next,
      cursor: reportedGone.messageId,
      gone: new Set(next.gone).add(reportedGone.messageId),
      goneReportKey: reportedGone.key,
    };
  }
  return next;
}

/** Like a messenger, the bar then offers the next older pin. */
export function pinnedMessageBarAfterJump(
  state: PinnedMessageBarState,
  pins: ReadonlyArray<PinnedMessage>,
  messageId: MessageId,
): PinnedMessageBarState {
  return { ...state, cursor: nextPinnedMessageId(pins, messageId) ?? messageId };
}

export function pinnedMessageBarAfterUnpin(
  state: PinnedMessageBarState,
  pins: ReadonlyArray<PinnedMessage>,
  messageId: MessageId,
): PinnedMessageBarState {
  return pinnedMessageBar(pins, state.cursor)?.pin.messageId === messageId
    ? { ...state, cursor: nextPinnedMessageId(pins, messageId) }
    : state;
}

export function updateStoredPinnedMessages(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  update: (pins: ReadonlyArray<PinnedMessage>) => ReadonlyArray<PinnedMessage>,
) {
  const saved = writeLocalStorageValue(
    pinnedMessagesStorageKey(environmentId, threadId),
    (pins) => update(pins ?? NO_PINS),
    null,
    StoredPinnedMessages,
  );
  if (!saved) {
    toastManager.add({
      type: "error",
      title: "Could not save pins",
      description: "This browser refused to store them. Its storage may be full or blocked.",
    });
  }
}

export function clearStoredPinnedMessages(environmentId: EnvironmentId, threadId: ThreadId) {
  writeLocalStorageValue(
    pinnedMessagesStorageKey(environmentId, threadId),
    null,
    null,
    StoredPinnedMessages,
  );
}

export function readStoredPinnedMessages(environmentId: EnvironmentId, threadId: ThreadId) {
  return readLocalStorageValue(
    pinnedMessagesStorageKey(environmentId, threadId),
    NO_PINS,
    PinnedMessages,
  );
}

export function usePinnedMessages(environmentId: EnvironmentId, threadId: ThreadId) {
  const [pins] = useLocalStorage(
    pinnedMessagesStorageKey(environmentId, threadId),
    NO_PINS,
    PinnedMessages,
  );
  return pins;
}

/** Asks the thread's pin bar to open its list, e.g. from the command palette. */
export const usePinnedMessagesListRequest = create<{
  readonly threadKey: string | null;
  readonly requestId: number;
}>(() => ({ threadKey: null, requestId: 0 }));

export function openPinnedMessagesList(threadKey: string) {
  usePinnedMessagesListRequest.setState((state) => ({
    threadKey,
    requestId: state.requestId + 1,
  }));
}
