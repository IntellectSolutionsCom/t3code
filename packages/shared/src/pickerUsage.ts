import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { remainingPercent } from "./usageLimits.ts";
import { formatDuration } from "./usageLimitsCopy.ts";

const MINUTE = 60_000;
const STALE_MS = 30 * MINUTE;
const WARN_LEFT = 10;

// Copies the per-driver rules of exhaustedUsageWindow (usageLimits.ts) and the server's
// windowLimitsModel (claudeUsageLimits.ts); re-check both at each rebase.
function appliesTo(driver: string, model: string, windows: readonly ServerProviderUsageWindow[]) {
  const hasPlanWindows = windows.some((w) => w.id === "primary" || w.id === "secondary");
  const family = model.match(/^(gemini|claude|gpt)-/)?.[1];
  const token = model.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return (window: ServerProviderUsageWindow) => {
    if (window.modelIds && !window.modelIds.includes(model)) return false;
    if (window.providerIds && !window.providerIds.includes(model.split("/")[0] ?? "")) return false;
    switch (driver) {
      case "claudeAgent":
        return !window.id.startsWith("seven_day_") || token.includes(window.id.slice(10));
      case "antigravity": {
        const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
        return (
          pool === undefined ||
          family === undefined ||
          pool === family ||
          (pool === "3p" && (family === "claude" || family === "gpt"))
        );
      }
      case "codex":
        return window.id !== "individual" || !hasPlanWindows;
      case "opencode":
        return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
      default:
        return true;
    }
  };
}

function tightest(windows: readonly ServerProviderUsageWindow[], kind: string) {
  let best: { window: ServerProviderUsageWindow; left: number } | undefined;
  for (const window of windows) {
    if (window.kind !== kind) continue;
    const left = remainingPercent(window);
    if (!best || left < best.left) best = { window, left };
  }
  return best;
}

/** What is left of the selected model's week, or null when no fresh reading applies to it. */
export function pickerUsage(input: {
  readonly driver: string;
  readonly limits: ServerProviderUsageLimits | null | undefined;
  readonly model: string;
  readonly now: number;
}) {
  const { limits, now } = input;
  if (!limits || limits.unavailable) return null;
  const checkedAt = Date.parse(limits.checkedAt);
  if (!(now - checkedAt <= STALE_MS)) return null;
  const applies = appliesTo(input.driver, input.model, limits.windows);
  // A window whose reset has passed holds a figure from before it, so it is not counted.
  const windows = limits.windows.filter(
    (window) => applies(window) && !(window.resetsAt && Date.parse(window.resetsAt) <= now),
  );
  const weekly = tightest(windows, "weekly");
  if (!weekly) return null;
  const short = tightest(windows, "session");
  return {
    weekly,
    ...(short && short.left <= WARN_LEFT ? { short } : {}),
    warn: weekly.left <= WARN_LEFT,
    checkedAt,
  };
}

/** The tooltip's lines on web and the model sheet's on mobile. */
export function pickerUsageLines(
  usage: NonNullable<ReturnType<typeof pickerUsage>>,
  now: number,
  resolve: MFunctionType = mFallback,
): string[] {
  const left = ({ window, left }: typeof usage.weekly) =>
    resolve(msg("{label}: {left}% left", { label: window.label, left }));
  const resetsAt = usage.weekly.window.resetsAt ? Date.parse(usage.weekly.window.resetsAt) : NaN;
  const readAgo = now - usage.checkedAt;
  return [
    left(usage.weekly),
    ...(Number.isFinite(resetsAt)
      ? [
          resolve(
            msg("Resets in {duration}", { duration: formatDuration(resetsAt - now, resolve) }),
          ),
        ]
      : []),
    readAgo < MINUTE
      ? resolve(msg("Read just now", { $context: "when usage limits were last read" }))
      : resolve(msg("Read {duration} ago", { duration: formatDuration(readAgo, resolve) })),
    ...(usage.short ? [resolve(msg("5-hour: {left}% left", { left: usage.short.left }))] : []),
  ];
}
