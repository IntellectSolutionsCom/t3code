import { pickerUsage, pickerUsageLines } from "@t3tools/shared/picker-usage";
import { useMessages } from "gt-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import type { ProviderInstanceEntry } from "../providerInstances";

const circle = { cx: 10, cy: 10, r: 9.25, fill: "none", stroke: "currentColor", strokeWidth: 1.5 };

/** A ring over the picker's provider icon: what is left of the selected model's week. */
export function ProviderUsageArc(props: {
  readonly entry: ProviderInstanceEntry;
  readonly model: string;
}) {
  const m = useMessages();
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const { driver, usageLimits } = props.entry.snapshot;
  const usage = pickerUsage({ driver, limits: usageLimits, model: props.model, now });
  if (!usage) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="absolute -inset-0.5 flex" />}>
        <svg
          data-composer-control-icon
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={cn("size-5 -rotate-90", usage.warn ? "text-warning" : "text-foreground")}
        >
          <circle {...circle} strokeOpacity={usage.warn ? 0.35 : 0.12} />
          <circle
            {...circle}
            strokeOpacity={usage.warn ? 1 : 0.85}
            pathLength={100}
            strokeDasharray={`${usage.weekly.left} 100`}
          />
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {pickerUsageLines(usage, now, m).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}
