import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import Migration0001 from "./migrations/0001_LinkMessageGrants.ts";
import Migration0002 from "./migrations/0002_ThreadBadges.ts";
import Migration0003 from "./migrations/0003_NativeSessionOut.ts";
import { forkMigrationManifest, runForkMigrations } from "./migrations.ts";

const ledger = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
  `.pipe(Effect.map((rows) => rows.map((row) => [row.migration_id, row.name] as const)));

it.layer(SqlitePersistence.layerMemory)("fork migrations", (it) => {
  it.effect("run once on a ledger of their own and leave upstream's equal to its manifest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* ledger(sql, "t3f_migrations"), [
        [1, "LinkMessageGrants"],
        [2, "ThreadBadges"],
        [3, "NativeSessionOut"],
        [4, "NativeSessionTakenBackAt"],
      ]);
      assert.deepEqual(yield* ledger(sql, "t3f_migrations"), forkMigrationManifest);
      assert.deepEqual(yield* ledger(sql, "effect_sql_migrations"), migrationManifest);

      assert.deepEqual(yield* runForkMigrations(), []);
      assert.deepEqual(yield* ledger(sql, "t3f_migrations"), forkMigrationManifest);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't3f\_%' ESCAPE '\\'
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          "t3f_link_message_grants",
          "t3f_link_sessions",
          "t3f_migrations",
          "t3f_native_session_out",
          "t3f_thread_badges",
        ],
      );
    }),
  );
});

it.effect("refuse a history that records one of their ids under another name or skips one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const noop = Effect.void;
    yield* runForkMigrations([[1, "LinkMessageGrants", noop]]);
    assert.deepEqual(
      yield* runForkMigrations([
        [1, "LinkMessageGrants", noop],
        [3, "NativeSessionOut", noop],
      ]),
      [[3, "NativeSessionOut"]],
    );
    yield* sql`DELETE FROM t3f_migrations WHERE migration_id = 3`;
    yield* sql`INSERT INTO t3f_migrations (migration_id, name) VALUES (2, 'Other')`;

    const renamed = yield* runForkMigrations([
      [1, "LinkMessageGrants", noop],
      [2, "Mine", noop],
    ]).pipe(Effect.flip);
    assert.include(renamed.message, "2_Mine (recorded: Other)");

    yield* sql`DELETE FROM t3f_migrations WHERE migration_id = 1`;
    const skipped = yield* runForkMigrations([
      [1, "LinkMessageGrants", noop],
      [2, "Other", noop],
    ]).pipe(Effect.flip);
    assert.include(skipped.message, "1_LinkMessageGrants (recorded: nothing)");

    // A build that fills an id below one a later build recorded: the gap is refused, not skipped.
    yield* sql`DELETE FROM t3f_migrations`;
    yield* sql`INSERT INTO t3f_migrations (migration_id, name) VALUES (1, 'LinkMessageGrants'), (3, 'Third')`;
    const gap = yield* runForkMigrations([
      [1, "LinkMessageGrants", noop],
      [2, "ThreadBadges", noop],
      [3, "Third", noop],
    ]).pipe(Effect.flip);
    assert.include(gap.message, "2_ThreadBadges (recorded: nothing)");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("migration 4 keeps the sessions already out", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runForkMigrations([
      [1, "LinkMessageGrants", Migration0001],
      [2, "ThreadBadges", Migration0002],
      [3, "NativeSessionOut", Migration0003],
    ]);
    yield* sql`
      INSERT INTO t3f_native_session_out (thread_id, environment_id, driver, native_id, handed_out_at)
      VALUES ('thread', 'environment', 'codex', 'native', '2026-11-21T12:00:00.000Z')
    `;

    assert.deepEqual(yield* runForkMigrations(), [[4, "NativeSessionTakenBackAt"]]);
    assert.deepEqual(yield* sql`SELECT * FROM t3f_native_session_out`, [
      {
        thread_id: "thread",
        environment_id: "environment",
        driver: "codex",
        native_id: "native",
        handed_out_at: "2026-11-21T12:00:00.000Z",
        taken_back_at: null,
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
