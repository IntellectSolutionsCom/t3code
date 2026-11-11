import type { MessageId } from "@t3tools/contracts";
import { ListIcon, PinIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import {
  initialPinnedMessageBarState,
  newestPinsFirst,
  pinnedMessageBar,
  pinnedMessageBarAfterJump,
  pinnedMessageBarAfterUnpin,
  reconcilePinnedMessageBar,
  usePinnedMessagesListRequest,
  type PinnedMessage,
} from "./pinnedMessages";

/** The bar's padded height; the timeline and the canvas keep this much clear at the top. */
export const PINNED_MESSAGES_BAR_RESERVED_HEIGHT = 44;

export const PinnedMessagesBar = memo(function PinnedMessagesBar({
  threadKey,
  pins,
  reportedGone,
  onJump,
  onUnpin,
}: {
  threadKey: string;
  pins: ReadonlyArray<PinnedMessage>;
  /** The current jump, when it found the pinned message gone from the thread. */
  reportedGone: { readonly key: string; readonly messageId: MessageId } | null;
  onJump: (messageId: MessageId) => void;
  onUnpin: (messageId: MessageId) => void;
}) {
  const [state, setState] = useState(() => initialPinnedMessageBarState(pins));
  const reconciled = reconcilePinnedMessageBar(state, pins, reportedGone);
  if (reconciled !== state) setState(reconciled);
  const [listOpen, setListOpen] = useState(false);
  const listRequest = usePinnedMessagesListRequest();
  const [seenListRequestId, setSeenListRequestId] = useState(listRequest.requestId);
  if (listRequest.requestId !== seenListRequestId) {
    setSeenListRequestId(listRequest.requestId);
    if (listRequest.threadKey === threadKey) setListOpen(true);
  }

  const bar = pinnedMessageBar(pins, reconciled.cursor);
  if (!bar) return null;
  const shown = bar.pin.messageId;
  const shownGone = reconciled.gone.has(shown);
  const jump = (messageId: MessageId) => {
    onJump(messageId);
    setState(pinnedMessageBarAfterJump(reconciled, pins, messageId));
  };
  const unpin = (messageId: MessageId) => {
    setState(pinnedMessageBarAfterUnpin(reconciled, pins, messageId));
    onUnpin(messageId);
  };

  return (
    <section aria-label="Pinned messages" className="pointer-events-auto px-3 pt-2 sm:px-12">
      <div
        className="mx-auto flex h-9 w-full max-w-(--chat-content-max-width) items-center gap-0.5 rounded-lg border bg-popover pe-1 shadow-xs/5"
        data-pinned-messages-bar
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-s-lg ps-3 pe-2 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Go to pinned message ${bar.position} of ${bar.total}: ${bar.pin.label}${shownGone ? " (no longer in this thread)" : ""}`}
          onClick={() => jump(shown)}
        >
          <PinIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              shownGone && "text-muted-foreground line-through",
            )}
          >
            {bar.pin.label}
          </span>
          {bar.total > 1 ? (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {bar.position} of {bar.total}
            </span>
          ) : null}
        </button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Unpin message"
          onClick={() => unpin(shown)}
        >
          <XIcon />
        </Button>
        <Popover open={listOpen} onOpenChange={setListOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Show pinned messages"
              />
            }
          >
            <ListIcon />
          </PopoverTrigger>
          <PopoverPopup align="end" width="md" padding="compact">
            <PopoverTitle className="mx-1 mb-2">Pinned messages</PopoverTitle>
            <ul className="flex flex-col gap-0.5">
              {newestPinsFirst(pins).map((pin) => {
                const gone = reconciled.gone.has(pin.messageId);
                return (
                  <li key={pin.messageId} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer rounded-md px-1 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => {
                        setListOpen(false);
                        jump(pin.messageId);
                      }}
                    >
                      <span
                        className={cn("block truncate text-sm", gone && "text-muted-foreground")}
                      >
                        {pin.label}
                      </span>
                      {gone ? (
                        <span className="block text-muted-foreground text-xs">
                          No longer in this thread
                        </span>
                      ) : null}
                    </button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Unpin ${pin.label}`}
                      onClick={() => unpin(pin.messageId)}
                    >
                      <XIcon />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </PopoverPopup>
        </Popover>
      </div>
    </section>
  );
});
