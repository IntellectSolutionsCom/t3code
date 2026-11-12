import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexAutoCompactTokenLimit,
  codexExecLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("codexAutoCompactTokenLimit", () => {
  it("reads the last model_auto_compact_token_limit override, or nothing", () => {
    const cases: ReadonlyArray<readonly [string, number | undefined]> = [
      ["-c model_auto_compact_token_limit=200000", 200_000],
      ["--config=model_auto_compact_token_limit=180_000 --strict-config", 180_000],
      ["-c model_auto_compact_token_limit=1 -c 'model_auto_compact_token_limit = 150000'", 150_000],
      ['-c model_auto_compact_token_limit="200000"', 200_000],
      [String.raw`-c model_auto_compact_token_limit=\"200000\"`, undefined],
      ["-c model=gpt-5.4 --enable model_auto_compact_token_limit=200000", undefined],
      [
        String.raw`-c model_auto_compact_token_limit=200000 -c model_auto_compact_token_limit_scope=\"total\"`,
        200_000,
      ],
      [
        "-c model_auto_compact_token_limit=200000 -c model_auto_compact_token_limit_scope=body_after_prefix",
        undefined,
      ],
      ["", undefined],
    ];
    for (const [launchArgs, limit] of cases) {
      NodeAssert.strictEqual(codexAutoCompactTokenLimit(launchArgs), limit, launchArgs);
    }
  });
});
