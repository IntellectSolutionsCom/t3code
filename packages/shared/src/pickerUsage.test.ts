import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { pickerUsage } from "./pickerUsage.ts";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000));
const future = "2026-11-28T12:00:00.000Z";

const w = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent, resetsAt: future, ...extra });

const limits = (
  windows: ServerProviderUsageWindow[],
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({ checkedAt: minutesAgo(2), windows, ...extra });

const claude = (weekly: number, fable: number) =>
  limits([
    w("five_hour", "session", 30),
    w("seven_day", "weekly", weekly),
    w("seven_day_fable", "weekly", fable),
  ]);
const antigravity = limits([
  w("gemini-5h", "session", 10),
  w("gemini-weekly", "weekly", 30),
  w("3p-5h", "session", 92),
  w("3p-weekly", "weekly", 27),
]);

type Expected = { id: string; left: number; short?: string; warn: boolean } | null;

const rows: ReadonlyArray<
  [string, string, ServerProviderUsageLimits | undefined, string, Expected]
> = [
  [
    "claude: Opus counts Weekly only",
    "claudeAgent",
    claude(52, 81),
    "claude-opus-5-5",
    { id: "seven_day", left: 48, warn: false },
  ],
  [
    "claude: Fable takes the tighter Weekly",
    "claudeAgent",
    claude(52, 19),
    "claude-fable-5-2",
    { id: "seven_day", left: 48, warn: false },
  ],
  [
    "claude: Fable takes its own week",
    "claudeAgent",
    claude(10, 95),
    "claude-fable-5-2",
    { id: "seven_day_fable", left: 5, warn: true },
  ],
  [
    "codex: Pro weekly primary",
    "codex",
    limits([w("primary", "weekly", 40), w("individual", "monthly", 99)]),
    "gpt-6.1",
    { id: "primary", left: 60, warn: false },
  ],
  [
    "codex: Plus 5-hour short line",
    "codex",
    limits([w("primary", "session", 92), w("secondary", "weekly", 30)]),
    "gpt-6.1",
    { id: "secondary", left: 70, short: "primary", warn: false },
  ],
  [
    "codex: individual ignored beside plan windows",
    "codex",
    limits([w("secondary", "weekly", 30), w("individual", "weekly", 99)]),
    "gpt-6.1",
    { id: "secondary", left: 70, warn: false },
  ],
  [
    "antigravity: Gemini takes gemini-weekly",
    "antigravity",
    antigravity,
    "gemini-4-pro",
    { id: "gemini-weekly", left: 70, warn: false },
  ],
  [
    "antigravity: Claude takes 3p-weekly with the 3p-5h line at 8%",
    "antigravity",
    antigravity,
    "claude-opus-5-5",
    { id: "3p-weekly", left: 73, short: "3p-5h", warn: false },
  ],
  [
    "antigravity: no 3p-5h line at 46%",
    "antigravity",
    limits([w("3p-5h", "session", 54), w("3p-weekly", "weekly", 27)]),
    "gpt-6",
    { id: "3p-weekly", left: 73, warn: false },
  ],
  ["kimi: no windows", "kimi", limits([]), "kimi-k3", null],
  [
    "a 31-minute-old reading",
    "codex",
    limits([w("primary", "weekly", 40)], { checkedAt: minutesAgo(31) }),
    "gpt-6.1",
    null,
  ],
  [
    "a 29-minute-old reading",
    "codex",
    limits([w("primary", "weekly", 40)], { checkedAt: minutesAgo(29) }),
    "gpt-6.1",
    { id: "primary", left: 60, warn: false },
  ],
  [
    "a reset at now",
    "codex",
    limits([w("primary", "weekly", 40, { resetsAt: minutesAgo(0) })]),
    "gpt-6.1",
    null,
  ],
  [
    "unavailable",
    "codex",
    limits([w("primary", "weekly", 40)], { unavailable: { reason: "probeFailed" } }),
    "gpt-6.1",
    null,
  ],
  ["no limits", "codex", undefined, "gpt-6.1", null],
  [
    "no applicable weekly window",
    "codex",
    limits([w("primary", "weekly", 40, { modelIds: ["gpt-other"] })]),
    "gpt-6.1",
    null,
  ],
  [
    "opencode: a non-Go model ignores the Go week",
    "opencode",
    limits([w("go_weekly", "weekly", 95), w("weekly", "weekly", 40)]),
    "opencode/big-pickle",
    { id: "weekly", left: 60, warn: false },
  ],
  [
    "opencode: a Go model counts the Go week",
    "opencode",
    limits([w("go_weekly", "weekly", 95), w("weekly", "weekly", 40)]),
    "opencode-go/kimi",
    { id: "go_weekly", left: 5, warn: true },
  ],
  [
    "a passed tighter week leaves the live warning",
    "claudeAgent",
    limits([
      w("seven_day", "weekly", 95),
      w("seven_day_fable", "weekly", 100, { resetsAt: minutesAgo(1) }),
    ]),
    "claude-fable-5-2",
    { id: "seven_day", left: 5, warn: true },
  ],
  [
    "exactly 10% left warns",
    "codex",
    limits([w("primary", "weekly", 90)]),
    "gpt-6.1",
    { id: "primary", left: 10, warn: true },
  ],
  [
    "an unparsable checkedAt",
    "codex",
    limits([w("primary", "weekly", 40)], { checkedAt: "not a time" }),
    "gpt-6.1",
    null,
  ],
  [
    "0% left warns, never null",
    "codex",
    limits([w("primary", "weekly", 100)]),
    "gpt-6.1",
    { id: "primary", left: 0, warn: true },
  ],
];

describe("pickerUsage", () => {
  it.each(rows)("%s", (_name, driver, input, model, expected) => {
    const usage = pickerUsage({ driver, limits: input, model, now });
    expect(
      usage && {
        id: usage.weekly.window.id,
        left: usage.weekly.left,
        ...(usage.short ? { short: usage.short.window.id } : {}),
        warn: usage.warn,
      },
    ).toEqual(expected);
  });
});
