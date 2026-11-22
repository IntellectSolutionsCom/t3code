import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";

import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { nativeSessionFileKey, readOutsideTurnTail } from "./nativeSessionFiles.ts";
import { compareCodex } from "./outsideTurns.ts";

describe("nativeSessionFileKey", () => {
  it.each([
    [
      "claudeAgent",
      "/h/projects/-p/5a3356c8-4ff1-46f9-908c-637454f147c4.jsonl",
      "5a3356c8-4ff1-46f9-908c-637454f147c4",
    ],
    [
      "codex",
      "/h/sessions/2026/08/20/rollout-2026-08-20T10-00-00-019a5f00-0000-7000-8000-00000000000c.jsonl.zst",
      "019a5f00-0000-7000-8000-00000000000c",
    ],
    [
      "codex",
      "/h/sessions/rollout-2026-08-20T10-00-00-019a5f00-0000-7000-8000-00000000000c_019a5f00-0000-7000-8000-0000000000ff.jsonl",
      "019a5f00-0000-7000-8000-00000000000c",
    ],
    ["pi", "/h/sessions/--p--/2026-08-24_pi.jsonl", null],
    ["codex", "/h/sessions/rollout-unknown.jsonl", null],
    ["cursor", "/h/x.jsonl", null],
  ])("%s %s", (source, filePath, key) => {
    expect(nativeSessionFileKey(source, filePath)).toBe(key);
  });
});

const start = (turn_id: string) =>
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id } });

it.effect.each([
  {
    name: "finds outside turns in the tail",
    anchorInTail: true,
    expected: { firstId: "outside", count: 1, shape: "linear" },
  },
  { name: "returns unknown when the anchor is cut off", anchorInTail: false, expected: "unknown" },
  {
    name: "skips a rewound rollout with the header cut off",
    anchorInTail: true,
    rewound: true,
    expected: undefined,
  },
])("$name of a rollout larger than 2 MiB", ({ anchorInTail, expected, rewound }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const directory = path.join(home, ".codex", "sessions", "2026", "11", "21");
    yield* fs.makeDirectory(directory, { recursive: true });
    const nativeId = "019a5f00-0000-7000-8000-00000000000c";
    const anchor = start("ours");
    const tail =
      anchor +
      "\n" +
      (anchorInTail ? anchor + "\n" : "") +
      start("outside") +
      "\n" +
      start("partial");
    const padding = " ".repeat(2 * 1024 * 1024 - tail.length);
    const header = rewound ? '{"type":"session_meta","payload":{"history_base":{}}}\n' : "";
    const prefix = header + (anchorInTail ? "" : anchor + "\n") + "x".repeat(2 * 1024 * 1024);
    const suffix = rewound ? "_019a5f00-0000-7000-8000-0000000000ff" : "";
    yield* fs.writeFileString(
      path.join(directory, `rollout-2026-11-21T10-00-00-${nativeId}${suffix}.jsonl`),
      prefix + tail.replace(start("partial"), padding + start("partial")),
    );
    const transcript = yield* readOutsideTurnTail(
      { driver: ProviderDriverKind.make("codex") },
      nativeId,
      undefined,
      0,
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
    if (rewound) {
      expect(transcript).toBeUndefined();
      return;
    }
    expect(transcript).toBeDefined();
    expect(compareCodex(transcript!, "ours", new Set(["ours"]))).toEqual(expected);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
