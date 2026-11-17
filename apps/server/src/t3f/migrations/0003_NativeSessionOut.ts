import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign key: a mark whose thread, session or environment is gone is ignored and removed.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3f_native_session_out (
      thread_id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      native_id TEXT NOT NULL,
      handed_out_at TEXT NOT NULL
    )
  `;
});
