import { expect, it } from "vite-plus/test";

import { buildReleaseRepository } from "./release-repository.ts";

it.each([
  [{}, ""],
  [{ GITHUB_REPOSITORY: " example/t3code-fork " }, "example/t3code-fork"],
  [
    { T3CODE_DESKTOP_UPDATE_REPOSITORY: "example/updates", GITHUB_REPOSITORY: "example/source" },
    "example/updates",
  ],
  [
    { T3CODE_DESKTOP_UPDATE_REPOSITORY: " ", GITHUB_REPOSITORY: "example/source" },
    "example/source",
  ],
])("names the build's release repository from %j", (env, repository) => {
  expect(buildReleaseRepository(env)).toBe(repository);
});

it.each(["example", "example/t3code/extra", "../t3code", "example/..", "example/t3 code"])(
  "refuses %j, which is not one <owner>/<repo>",
  (repository) => {
    expect(() => buildReleaseRepository({ GITHUB_REPOSITORY: repository })).toThrow(
      "GITHUB_REPOSITORY must be <owner>/<repo>",
    );
  },
);
