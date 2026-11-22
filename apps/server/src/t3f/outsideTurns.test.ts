import { expect, it } from "@effect/vitest";

import { compareClaude, compareCodex, completeTail } from "./outsideTurns.ts";

const jsonl = (...rows: ReadonlyArray<object>) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const start = (turn_id: string) => ({
  type: "event_msg",
  payload: { type: "task_started", turn_id },
});
const assistant = (uuid: string, parentUuid?: string) => ({ type: "assistant", uuid, parentUuid });
const prompt = (uuid: string, parentUuid: string, content: unknown = uuid) => ({
  type: "user",
  uuid,
  parentUuid,
  message: { content },
});

it.each([
  [
    "unrecorded starts only once",
    jsonl(start("ours"), start("a"), start("known"), start("a"), start("b")),
    { count: 2, firstId: "a", shape: "linear" },
  ],
  ["only known starts", jsonl(start("ours"), start("known")), "none"],
  ["no anchor", jsonl(start("a")), "unknown"],
  ["trailing fragment", jsonl(start("ours")) + JSON.stringify(start("a")), "none"],
  [
    "rewound rollout",
    jsonl({ type: "session_meta", payload: { history_base: {} } }, start("ours"), start("a")),
    "unknown",
  ],
] as const)("compares Codex logs with %s", (_name, raw, expected) => {
  expect(compareCodex(completeTail(raw), "ours", new Set(["ours", "known"]))).toEqual(expected);
});

it.each([
  [
    "linear",
    [
      assistant("cursor"),
      assistant("reply", "cursor"),
      prompt("a", "reply", [{ type: "text", text: "next" }]),
    ],
    { count: 1, firstId: "a", shape: "linear" },
  ],
  [
    "split",
    [assistant("cursor"), prompt("a", "before")],
    { count: 1, firstId: "a", shape: "split" },
  ],
  ["interrupted prompt", [assistant("cursor"), prompt("a", "cursor", "sent")], "none"],
  [
    "non-prompts",
    [
      assistant("cursor"),
      { ...prompt("meta", "cursor"), isMeta: true },
      { ...prompt("side", "cursor"), isSidechain: true },
      { ...prompt("summary", "cursor"), isCompactSummary: true },
      prompt("command", "cursor", "<command-name>/rename</command-name>"),
      prompt("tool", "cursor", [
        { type: "tool_result", content: "result" },
        { type: "text", text: "feedback" },
      ]),
    ],
    "none",
  ],
  ["no cursor", [prompt("a", "earlier")], "unknown"],
] as const)("compares Claude logs with %s", (_name, rows, expected) => {
  expect(compareClaude(jsonl(...rows), "cursor", new Set(["sent"]))).toEqual(expected);
});
