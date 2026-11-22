import { expect, it } from "@effect/vitest";

import { completeTail } from "./nativeSessionFiles.ts";
import { compareClaude, compareCodex } from "./outsideTurns.ts";

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
const taskNotification =
  '<task-notification>\n<task-id>bifwzfwct</task-id>\n<status>completed</status>\n<summary>Background command "build" completed</summary>\n</task-notification>';

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
      { ...prompt("a", "reply", [{ type: "text", text: "next" }]), origin: { kind: "human" } },
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
  [
    "task notification",
    [
      assistant("cursor"),
      { ...prompt("task", "cursor", taskNotification), origin: { kind: "task-notification" } },
    ],
    "none",
  ],
  [
    "compaction output",
    [
      assistant("cursor"),
      prompt("compact", "cursor", "<local-command-stdout>Compacted </local-command-stdout>"),
    ],
    "none",
  ],
  [
    "interrupt marker",
    [
      assistant("cursor"),
      prompt("interrupt", "cursor", [{ type: "text", text: "[Request interrupted by user]" }]),
    ],
    "none",
  ],
  [
    "quoted output in a typed prompt",
    [
      assistant("cursor"),
      {
        ...prompt("a", "cursor", "<local-command-stdout>Compacted </local-command-stdout>\nWhy?"),
        origin: { kind: "human" },
      },
    ],
    { count: 1, firstId: "a", shape: "linear" },
  ],
  [
    "quoted output across text blocks",
    [
      assistant("cursor"),
      {
        ...prompt("a", "cursor", [
          { type: "text", text: "<local-command-stdout>Compacted </local-command-stdout>" },
          { type: "text", text: "Why?" },
        ]),
        origin: { kind: "human" },
      },
    ],
    { count: 1, firstId: "a", shape: "linear" },
  ],
  [
    "skill sent from here",
    [
      assistant("cursor"),
      prompt(
        "skill",
        "cursor",
        "<command-message>1c-knowledge</command-message>\n<command-name>/1c-knowledge</command-name>\n<command-args>?</command-args>",
      ),
    ],
    "none",
  ],
  [
    "shell markup sent from here",
    [assistant("cursor"), prompt("a", "cursor", "<bash-input>pwd</bash-input>")],
    "none",
  ],
  [
    "command markup sent from here",
    [
      assistant("cursor"),
      prompt(
        "a",
        "cursor",
        "<command-message>example</command-message>\n<command-args>arg</command-args>",
      ),
    ],
    "none",
  ],
  ["no cursor", [prompt("a", "earlier")], "unknown"],
] as const)("compares Claude logs with %s", (_name, rows, expected) => {
  expect(
    compareClaude(
      jsonl(...rows),
      "cursor",
      new Set([
        "sent",
        "/1c-knowledge ?",
        "<bash-input>pwd</bash-input>",
        "<command-message>example</command-message>\n<command-args>arg</command-args>",
      ]),
    ),
  ).toEqual(expected);
});
