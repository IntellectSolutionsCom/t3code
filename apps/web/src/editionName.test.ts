// @effect-diagnostics nodeBuiltinImport:off - greps the tracked source with git.
import * as NodeChildProcess from "node:child_process";

import { EDITION_NAME } from "@t3tools/shared/edition";
import { describe, expect, it } from "vite-plus/test";

import { EDITION_NAME_ALLOWED_WORDS } from "./editionNameAllowList";

const OWN_FILES = ["packages/shared/src/edition.ts", "apps/web/src/editionNameAllowList.ts"];

function trackedLinesNaming(name: string): ReadonlyArray<string> {
  const root = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
  try {
    return NodeChildProcess.execFileSync(
      "git",
      ["grep", "--untracked", "-I", "-i", "-n", "-F", name, "--", "apps", "packages"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

describe("edition name", () => {
  // Renaming the edition to a common word makes ordinary words match: review the allow-list then.
  it("appears in code only through its constant", () => {
    const name = EDITION_NAME.toLowerCase();
    const leaks = trackedLinesNaming(EDITION_NAME).filter((line) => {
      if (OWN_FILES.some((file) => line.startsWith(`${file}:`))) return false;
      const rest = EDITION_NAME_ALLOWED_WORDS.reduce(
        (text, word) => text.replaceAll(word.toLowerCase(), ""),
        line.toLowerCase(),
      );
      return rest.includes(name);
    });
    expect(leaks).toEqual([]);
  });
});
