import { assert, it } from "@effect/vitest";
import { ThreadId, type T3fThreadBadgeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadBadges from "./ThreadBadges.ts";

const live = ThreadId.make("thread-live");
const gone = ThreadId.make("thread-gone");
const other = ThreadId.make("thread-other");
const rocket = { symbol: "🚀", label: "Launch" };
const flag = { symbol: "🏳️‍🌈", label: "Review" };
const point = String.fromCodePoint;
const accent = `e${point(0x301)}`;
const coder = `${point(0x1f469)}${point(0x200d)}${point(0x1f4bb)}`;

const layer = ThreadBadges.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === gone ? null : ({ id: threadId, deletedAt: null } as never)),
    }),
  ),
);

/** Every row of every table that is not ours: all an official client's payloads come from these. */
const upstreamState = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) =>
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 't3f\\_%' ESCAPE '\\' ORDER BY name
      `;
      const rows: Record<string, unknown> = {};
      for (const { name } of tables) rows[name] = yield* sql`SELECT * FROM ${sql(name)}`;
      return rows;
    }),
  ),
);

it.layer(layer)("thread badges", (it) => {
  it.effect("set, replace, read and clear, touching nothing upstream", () =>
    Effect.gen(function* () {
      const badges = yield* ThreadBadges.ThreadBadges;
      const before = yield* upstreamState;

      assert.isNull(yield* badges.get(live));
      assert.deepEqual(yield* badges.set(live, { ...rocket, label: "  Launch  " }), rocket);
      assert.deepEqual(yield* badges.get(live), rocket);
      assert.deepEqual(yield* badges.set(live, flag), flag);
      assert.deepEqual(yield* badges.get(live), flag);
      assert.isNull(yield* badges.set(live, null));
      assert.isNull(yield* badges.get(live));

      assert.deepEqual(yield* upstreamState, before);
    }),
  );

  it.effect.each([
    { symbol: "x", label: "Label", reason: "invalid_symbol" },
    { symbol: "", label: "Label", reason: "invalid_symbol" },
    { symbol: "🚀🚀", label: "Label", reason: "invalid_symbol" },
    { symbol: "1", label: "Label", reason: "invalid_symbol" },
    { symbol: `${point(0x1f680)}${point(0x1f3fd)}`, label: "Label", reason: "invalid_symbol" },
    { symbol: "🚀", label: "   ", reason: "invalid_label" },
    { symbol: "🚀", label: "a".repeat(25), reason: "invalid_label" },
    { symbol: "🚀", label: accent.repeat(25), reason: "invalid_label" },
    { symbol: "🚀", label: coder.repeat(12), reason: "invalid_label" },
    { symbol: "🚀", label: "two\nlines", reason: "invalid_label" },
    { symbol: "🚀", label: `split${String.fromCodePoint(0x2028)}here`, reason: "invalid_label" },
  ])("refuses the symbol $symbol with label $label as $reason", ({ symbol, label, reason }) =>
    Effect.gen(function* () {
      const badges = yield* ThreadBadges.ThreadBadges;
      const refused = yield* badges.set(other, { symbol, label }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, reason);
      assert.isNull(yield* badges.get(other));
    }),
  );

  it.effect("accepts joined, flag and keycap emoji, and labels of exactly 24 characters", () =>
    Effect.gen(function* () {
      const badges = yield* ThreadBadges.ThreadBadges;
      for (const symbol of ["👩‍💻", "🇺🇦", "1️⃣", `${point(0x1f44d)}${point(0x1f3fd)}`]) {
        assert.deepEqual(yield* badges.set(other, { symbol, label: "é".repeat(24) }), {
          symbol,
          label: "é".repeat(24),
        });
      }
      // A character is what a reader sees: marks and joined emoji count once, not per code point.
      for (const label of [accent.repeat(24), coder.repeat(11)]) {
        assert.deepEqual(yield* badges.set(other, { symbol: "🚀", label }), {
          symbol: "🚀",
          label,
        });
      }
      yield* badges.set(other, null);
    }),
  );

  it.effect(
    "sets nothing on a deleted thread, hides what it left behind, and still clears it",
    () =>
      Effect.gen(function* () {
        const badges = yield* ThreadBadges.ThreadBadges;
        const sql = yield* SqlClient.SqlClient;
        const refused = yield* badges.set(gone, rocket).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "thread_not_found");

        yield* badges.set(live, flag);
        yield* sql`INSERT INTO t3f_thread_badges (thread_id, symbol, label) VALUES (${gone}, '🚀', 'Orphan')`;
        assert.isNull(yield* badges.get(gone));
        const [snapshot] = yield* badges.subscribe.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(
          snapshot?.type === "snapshot" && snapshot.badges.map(({ threadId }) => threadId),
          [live],
        );

        assert.isNull(yield* badges.set(gone, null));
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM t3f_thread_badges WHERE thread_id = ${gone}`,
          [],
        );
        yield* badges.set(live, null);
      }),
  );

  it.effect("a subscription sees the badges at its start, then every later change in order", () =>
    Effect.gen(function* () {
      const badges = yield* ThreadBadges.ThreadBadges;
      yield* badges.set(live, rocket);
      const opened = yield* Deferred.make<void>();
      const events = yield* badges.subscribe.pipe(
        Stream.tap(() => Deferred.succeed(opened, undefined)),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(opened);
      yield* badges.set(other, flag);
      yield* badges.set(live, null);
      yield* badges.set(other, rocket);

      const [snapshot, ...changes] = (yield* Fiber.join(
        events,
      )) as ReadonlyArray<T3fThreadBadgeEvent>;
      assert.deepEqual(snapshot, {
        type: "snapshot",
        revision: snapshot!.revision,
        badges: [{ threadId: live, ...rocket }],
      });
      assert.deepEqual(
        changes.map((change) => change.type === "changed" && [change.threadId, change.badge]),
        [
          [other, flag],
          [live, null],
          [other, rocket],
        ],
      );
      assert.deepEqual(
        changes.map((change) => change.revision),
        [snapshot!.revision + 1, snapshot!.revision + 2, snapshot!.revision + 3],
      );
      yield* badges.set(other, null);
    }),
  );
});
