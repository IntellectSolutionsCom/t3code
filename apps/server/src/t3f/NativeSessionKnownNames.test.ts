import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as NativeSessionKnownNames from "./NativeSessionKnownNames.ts";

const thread = ThreadId.make("thread");

it.layer(SqlitePersistence.layerMemory)("NativeSessionKnownNames", (it) => {
  it.effect("keeps the names of the thread's current session, newest last", () =>
    Effect.gen(function* () {
      const names = yield* NativeSessionKnownNames.make;
      assert.deepEqual(yield* names.get(thread, "first"), []);

      yield* names.add(thread, "first", "One");
      yield* names.add(thread, "first", " Two ");
      yield* names.add(thread, "first", "One");
      assert.deepEqual(yield* names.get(thread, "first"), ["Two", "One"]);
      assert.deepEqual(yield* names.get(thread, "second"), []);

      yield* names.add(thread, "second", "Three");
      assert.deepEqual(yield* names.get(thread, "first"), []);
      assert.deepEqual(yield* names.get(thread, "second"), ["Three"]);
    }),
  );

  it.effect("keeps the last eight and does not rewrite the newest name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const names = yield* NativeSessionKnownNames.make;
      for (const name of "abcdefghij") yield* names.add(thread, "third", name);
      assert.deepEqual(yield* names.get(thread, "third"), [..."cdefghij"]);

      yield* sql`
        CREATE TABLE writes (id INTEGER PRIMARY KEY AUTOINCREMENT)
      `;
      yield* sql`
        CREATE TRIGGER count_writes AFTER UPDATE ON t3f_native_session_names
        BEGIN INSERT INTO writes (id) VALUES (NULL); END
      `;
      yield* names.add(thread, "third", "j");
      assert.deepEqual(yield* sql`SELECT id FROM writes`, []);
      yield* names.add(thread, "third", "i");
      assert.deepEqual(yield* sql`SELECT id FROM writes`, [{ id: 1 }]);
    }),
  );
});
