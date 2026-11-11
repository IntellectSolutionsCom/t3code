import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { forkMigrationManifest, runForkMigrations } from "./migrations.ts";

const ledger = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
  `.pipe(Effect.map((rows) => rows.map((row) => [row.migration_id, row.name] as const)));

it.layer(SqlitePersistence.layerMemory)("fork migrations", (it) => {
  it.effect("run once on a ledger of their own and leave upstream's equal to its manifest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* ledger(sql, "t3f_migrations"), [[1, "LinkMessageGrants"]]);
      assert.deepEqual(yield* ledger(sql, "t3f_migrations"), forkMigrationManifest);
      assert.deepEqual(yield* ledger(sql, "effect_sql_migrations"), migrationManifest);

      assert.deepEqual(yield* runForkMigrations(), []);
      assert.deepEqual(yield* ledger(sql, "t3f_migrations"), [[1, "LinkMessageGrants"]]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't3f\_%' ESCAPE '\\'
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        ["t3f_link_message_grants", "t3f_link_sessions", "t3f_migrations"],
      );
    }),
  );
});

it.effect("refuse a history that records one of their ids under another name or skips one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const noop = Effect.void;
    yield* runForkMigrations([[1, "LinkMessageGrants", noop]]);
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
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
