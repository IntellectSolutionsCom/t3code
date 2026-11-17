import { assert, describe, it } from "@effect/vitest";

import { ThreadId } from "../baseSchemas.ts";
import { handOutRefusal } from "./nativeSessions.ts";

describe("handOutRefusal", () => {
  const threadId = ThreadId.make("thread:refusal");
  it.each([
    { runs: [{ status: "running" }], tasks: 0, refused: /A turn is running/ },
    { runs: [{ status: "starting" }], tasks: 0, refused: /A turn is running/ },
    { runs: [{ status: "completed" }, { status: "queued" }], tasks: 0, refused: /queued/ },
    { runs: [{ status: "completed" }], tasks: 1, refused: /Background tasks/ },
    { runs: [{ status: "completed" }, { status: "failed" }], tasks: 0, refused: undefined },
  ] as const)("refuses $runs.0.status with $tasks background tasks", ({ runs, tasks, refused }) => {
    const refusal = handOutRefusal(threadId, runs, [
      {
        appThreadId: threadId,
        pendingBackgroundTasks: Array.from({ length: tasks }, () => ({}) as never),
      },
    ]);
    if (refused === undefined) assert.isUndefined(refusal);
    else assert.match(refusal ?? "", refused);
  });
});
