import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No foreign key: a row whose thread or session is gone is never read.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3f_native_session_names (
      thread_id TEXT PRIMARY KEY NOT NULL,
      native_id TEXT NOT NULL,
      known_names TEXT NOT NULL
    )
  `;
});
