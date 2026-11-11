import type { MessageId } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";
import { use } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

export function MessagePinButton({
  messageId,
  label,
}: {
  messageId: MessageId;
  /** Read only when pinning, so rows don't derive a label on every render. */
  label: () => string;
}) {
  const pins = use(TimelineRowCtx).pinnedMessages;
  if (!pins) return null;
  const pinned = pins.ids.has(messageId);
  const action = pinned ? "Unpin message" : "Pin message";
  const Icon = pinned ? PinOffIcon : PinIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={action}
            onClick={() => pins.toggle(messageId, label())}
            type="button"
            size="xs"
            variant="ghost-muted"
          />
        }
      >
        <Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{action}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
