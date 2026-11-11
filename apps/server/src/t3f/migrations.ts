import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import Migration0001 from "./migrations/0001_LinkMessageGrants.ts";

/**
 * The fork's schema, on a ledger of its own so upstream's ledger and its checks never see it.
 * Ids only grow: a later change appends one entry and never renames, reorders or edits one.
 */
const forkMigrationEntries = [[1, "LinkMessageGrants", Migration0001]] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const FORK_MIGRATIONS_TABLE = "t3f_migrations";

const run = Migrator.make({});

/** The migrator skips every id up to the highest recorded, so a skipped or renamed id must stop startup. */
const assertForkMigrationsCanRun = Effect.fn("assertForkMigrationsCanRun")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const renamed = recorded.flatMap((row) => {
    const expected = manifest.find(([id]) => id === row.migration_id)?.[1];
    return expected === undefined || expected === row.name
      ? []
      : [`${row.migration_id}_${expected} (recorded: ${row.name})`];
  });
  const skipped = manifest.flatMap(([id, name]) =>
    id <= latestRecordedId && !recordedNames.has(id) ? [`${id}_${name} (recorded: nothing)`] : [],
  );
  const problems = [...renamed, ...skipped];
  if (problems.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's fork migration history does not match this build: ${problems.join(", ")}. Start the build that wrote it.`,
  });
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* (
  entries: ReadonlyArray<
    readonly [number, string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>]
  > = forkMigrationEntries,
) {
  yield* assertForkMigrationsCanRun(entries.map(([id, name]) => [id, name] as const));
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
    table: FORK_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
