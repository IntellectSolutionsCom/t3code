import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { toastManager } from "../ui/toast";
import {
  MAX_PINNED_MESSAGES,
  PINNED_MESSAGE_LABEL_MAX_LENGTH,
  initialPinnedMessageBarState,
  nextPinnedMessageId,
  pinMessage,
  pinnedMessageBar,
  pinnedMessageBarAfterJump,
  pinnedMessageBarAfterUnpin,
  reconcilePinnedMessageBar,
  unpinMessage,
  updateStoredPinnedMessages,
  type PinnedMessage,
} from "./pinnedMessages";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

const pin = (id: string, pinnedAt: string): PinnedMessage => ({
  messageId: MessageId.make(id),
  label: id,
  pinnedAt,
});

describe("pinned message store", () => {
  it("pins once, clamps the label, and unpins", () => {
    const first = pinMessage([], {
      messageId: MessageId.make("a"),
      label: `  ${"x".repeat(400)}\n\nmore  `,
      pinnedAt: "2026-11-11T10:00:00.000Z",
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.label).toHaveLength(PINNED_MESSAGE_LABEL_MAX_LENGTH);
    expect(first[0]!.label.startsWith("xxx")).toBe(true);

    const again = pinMessage(first, {
      messageId: MessageId.make("a"),
      label: "other",
      pinnedAt: "2026-11-11T11:00:00.000Z",
    });
    expect(again).toBe(first);

    expect(unpinMessage(first, MessageId.make("a"))).toEqual([]);
    expect(unpinMessage(first, MessageId.make("missing"))).toBe(first);
  });

  it("refuses a pin past the per-thread cap", () => {
    const full = Array.from({ length: MAX_PINNED_MESSAGES }, (_, index) =>
      pin(`m${index}`, `2026-11-11T10:00:${String(index).padStart(2, "0")}.000Z`),
    );
    const next = pinMessage(full, {
      messageId: MessageId.make("one-more"),
      label: "one more",
      pinnedAt: "2026-11-11T12:00:00.000Z",
    });
    expect(next).toBe(full);
  });

  it("tells the user when the browser refuses to save a pin", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        },
      },
    });
    using add = vi.spyOn(toastManager, "add");
    try {
      updateStoredPinnedMessages(ENVIRONMENT_ID, ThreadId.make("thread-full"), (pins) =>
        pinMessage(pins, pin("refused", "2026-11-11T10:00:00.000Z")),
      );
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("pinned message bar", () => {
  const pins = [
    pin("oldest", "2026-11-11T10:00:00.000Z"),
    pin("newest", "2026-11-11T12:00:00.000Z"),
    pin("middle", "2026-11-11T11:00:00.000Z"),
  ];

  it("shows the newest pin until a jump moves it", () => {
    expect(pinnedMessageBar(pins, null)).toMatchObject({
      pin: { messageId: "newest" },
      position: 1,
      total: 3,
    });
    expect(pinnedMessageBar(pins, MessageId.make("middle"))).toMatchObject({
      pin: { messageId: "middle" },
      position: 2,
    });
    expect(pinnedMessageBar([], null)).toBeNull();
  });

  const shownId = (pinsNow: ReadonlyArray<PinnedMessage>, cursor: MessageId | null) =>
    pinnedMessageBar(pinsNow, cursor)?.pin.messageId;

  it("shows a pin added after a jump moved the bar", () => {
    const jumped = pinnedMessageBarAfterJump(
      initialPinnedMessageBarState(pins),
      pins,
      MessageId.make("newest"),
    );
    expect(shownId(pins, jumped.cursor)).toBe("middle");
    const added = pinMessage(pins, pin("added", "2026-11-11T13:00:00.000Z"));
    const state = reconcilePinnedMessageBar(jumped, added, null);
    expect(pinnedMessageBar(added, state.cursor)).toMatchObject({
      pin: { messageId: "added" },
      position: 1,
      total: 4,
    });
    // Unpinning an older pin elsewhere leaves the bar where it is.
    const fewer = unpinMessage(added, MessageId.make("oldest"));
    expect(reconcilePinnedMessageBar(state, fewer, null)).toBe(state);
  });

  it("keeps the bar and the gone mark on a pin whose jump found it gone", () => {
    const middle = MessageId.make("middle");
    let state = pinnedMessageBarAfterJump(initialPinnedMessageBarState(pins), pins, middle);
    expect(shownId(pins, state.cursor)).toBe("oldest");
    state = reconcilePinnedMessageBar(state, pins, { key: "jump-1", messageId: middle });
    expect(shownId(pins, state.cursor)).toBe("middle");
    expect(state.gone.has(middle)).toBe(true);
    // Another jump, and its fresh check, keep the mark for this thread view.
    state = pinnedMessageBarAfterJump(state, pins, MessageId.make("oldest"));
    state = reconcilePinnedMessageBar(state, pins, null);
    expect(shownId(pins, state.cursor)).toBe("newest");
    expect(state.gone.has(middle)).toBe(true);
    // Checking the same pin again stays on it.
    state = pinnedMessageBarAfterJump(state, pins, middle);
    state = reconcilePinnedMessageBar(state, pins, { key: "jump-2", messageId: middle });
    expect(shownId(pins, state.cursor)).toBe("middle");
  });

  it("steps to the next older pin and wraps to the newest", () => {
    expect(nextPinnedMessageId(pins, MessageId.make("newest"))).toBe("middle");
    expect(nextPinnedMessageId(pins, MessageId.make("middle"))).toBe("oldest");
    expect(nextPinnedMessageId(pins, MessageId.make("oldest"))).toBe("newest");
  });

  it("shows the next older pin after the shown pin is unpinned", () => {
    const shown = MessageId.make("middle");
    const state = pinnedMessageBarAfterJump(
      initialPinnedMessageBarState(pins),
      pins,
      MessageId.make("newest"),
    );
    const next = pinnedMessageBarAfterUnpin(state, pins, shown);
    const remaining = unpinMessage(pins, shown);
    expect(pinnedMessageBar(remaining, next.cursor)).toMatchObject({
      pin: { messageId: "oldest" },
      position: 2,
      total: 2,
    });
    // Unpinning a pin the bar does not show leaves the bar on its pin.
    expect(pinnedMessageBarAfterUnpin(state, pins, MessageId.make("oldest"))).toBe(state);
    // A lone pin has no other to step to.
    expect(nextPinnedMessageId([pins[0]!], MessageId.make("oldest"))).toBeNull();
  });
});
