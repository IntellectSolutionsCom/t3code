import { assert, it } from "@effect/vitest";
import { upstreamBaseVersion } from "./upstreamBaseVersion.ts";

it.each([
  ["0.1.10904", "0.1.9"],
  ["0.1.11001", "0.1.10"],
  ["0.1.11002", "0.1.10"],
  ["0.1.11101", "0.1.11"],
  ["0.1.10801", "0.1.8"],
  ["0.1.11199", "0.1.11"],
  ["0.1.11", "0.1.11"],
  ["0.0.46", "0.0.46"],
  ["1.2.3", "1.2.3"],
  ["0.1.11-beta.1", "0.1.11-beta.1"],
  ["0.1.11101+build.7", "0.1.11101+build.7"],
  ["not a version", "not a version"],
])("maps %s to %s for upstream compatibility", (version, expected) => {
  assert.strictEqual(upstreamBaseVersion(version), expected);
});
