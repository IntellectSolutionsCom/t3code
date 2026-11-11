import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keyed by auth session id with no foreign key: a revoked or expired session leaves a row that matches no caller.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3f_link_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3f_link_message_grants (
      session_id TEXT PRIMARY KEY NOT NULL,
      granted_at TEXT NOT NULL,
      granted_by_session_id TEXT NOT NULL
    )
  `;
});
