import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadBadge } from "./threadBadges";

/** The symbol alone suits a row; the label rides in its hover text and the row's accessible name. */
export function ThreadBadgeMark(props: {
  readonly threadRef: ScopedThreadRef;
  readonly showLabel?: boolean;
  readonly className?: string;
}) {
  const badge = useThreadBadge(props.threadRef);
  if (badge === null) return null;
  const mark = (
    <span
      data-testid="thread-badge"
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        // Beside a title, the label gives way to the title first.
        props.showLabel ? "min-w-5 shrink-[3] overflow-hidden" : "shrink-0",
        props.className,
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        {badge.symbol}
      </span>
      {props.showLabel ? (
        <span className="max-w-32 min-w-0 truncate text-muted-foreground">{badge.label}</span>
      ) : (
        <span className="sr-only">{badge.label}</span>
      )}
    </span>
  );
  if (props.showLabel) return mark;
  return (
    <Tooltip>
      <TooltipTrigger render={mark} />
      <TooltipPopup side="top">{badge.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A row's accessible name carries the badge label, since the row hides its own children. */
export function useBadgedTitle(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
}) {
  const badge = useThreadBadge(scopeThreadRef(thread.environmentId, thread.id));
  return badge === null ? thread.title : `${thread.title}, ${badge.label}`;
}
