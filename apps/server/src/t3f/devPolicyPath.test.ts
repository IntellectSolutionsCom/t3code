import { describe, expect, it } from "@effect/vitest";

import { isSourceBuild } from "./devPolicyPath.ts";

describe("isSourceBuild", () => {
  it.each([
    ["", true],
    ["IntellectSolutionsCom/t3code", false],
    ["pingdotgg/t3code", false],
  ])("release repository %j → %s", (repository, expected) => {
    expect(isSourceBuild(repository)).toBe(expected);
  });
});
