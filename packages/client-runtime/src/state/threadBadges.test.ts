import { describe, expect, it } from "@effect/vitest";
import { T3F_WS_METHODS, ThreadId, type T3fThreadBadgeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { followThreadBadges } from "./threadBadges.ts";

const a = ThreadId.make("thread-a");
const b = ThreadId.make("thread-b");
const rocket = { symbol: "🚀", label: "Launch" };
const flag = { symbol: "🏁", label: "Done" };

const run = (events: ReadonlyArray<T3fThreadBadgeEvent>) =>
  Stream.runCollect(followThreadBadges(Stream.fromIterable(events)));

describe("thread badges", () => {
  it.effect("follow a snapshot and the changes after it, ignoring one that is not newer", () =>
    Effect.gen(function* () {
      const states = yield* run([
        { type: "snapshot", revision: 4, badges: [{ threadId: a, ...rocket }] },
        { type: "changed", revision: 5, threadId: b, badge: flag },
        { type: "changed", revision: 5, threadId: a, badge: null },
        { type: "changed", revision: 6, threadId: a, badge: null },
      ]);
      expect(
        states.map((state) =>
          state.supported ? [state.revision, [...state.badges.keys()]] : "unsupported",
        ),
      ).toEqual([
        [4, [a]],
        [5, [a, b]],
        [5, [a, b]],
        [6, [b]],
      ]);
    }),
  );

  it.effect("replace what they hold when a new snapshot arrives after a reconnect", () =>
    Effect.gen(function* () {
      const states = yield* run([
        { type: "snapshot", revision: 9, badges: [{ threadId: a, ...rocket }] },
        { type: "snapshot", revision: 0, badges: [] },
      ]);
      const last = [...states].at(-1);
      expect(last?.supported && [last.revision, last.badges.size]).toEqual([0, 0]);
    }),
  );

  it.effect("show no badges on a server that does not know the subscription", () =>
    Effect.gen(function* () {
      const [state] = yield* Stream.runCollect(
        followThreadBadges(
          Stream.die(`Unknown request tag: ${T3F_WS_METHODS.threadBadgesSubscribe}`),
        ),
      );
      expect(state).toEqual({ supported: false });
      const other = yield* Stream.runCollect(
        followThreadBadges(Stream.die("Unknown request tag: x")),
      ).pipe(Effect.exit);
      expect(other._tag).toBe("Failure");
    }),
  );
});
