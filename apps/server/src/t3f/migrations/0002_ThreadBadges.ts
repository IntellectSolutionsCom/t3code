import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keyed by thread id with no foreign key: a deleted thread leaves a row that matches nothing.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3f_thread_badges (
      thread_id TEXT PRIMARY KEY NOT NULL,
      symbol TEXT NOT NULL,
      label TEXT NOT NULL
    )
  `;
});
