import { describe, expect, it } from "@effect/vitest";

import { nativeSessionFileKey } from "./nativeSessionFiles.ts";

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
