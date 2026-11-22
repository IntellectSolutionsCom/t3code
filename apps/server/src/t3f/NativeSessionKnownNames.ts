import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

const MAX_KNOWN_NAMES = 8;
const Names = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeNames = Schema.decodeUnknownOption(Names);
const encodeNames = Schema.encodeEffect(Names);

/** The names T3 wrote to a native session, adopted from it, or saw equal to the title; oldest first. */
export class NativeSessionKnownNames extends Context.Service<
  NativeSessionKnownNames,
  {
    /** Empty when none is stored, or when they were stored for another session of the thread. */
    readonly get: (
      threadId: ThreadId,
      nativeId: string,
    ) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>;
    readonly add: (
      threadId: ThreadId,
      nativeId: string,
      name: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
  }
>()("t3/t3f/NativeSessionKnownNames") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("NativeSessionKnownNames.get")(function* (
    threadId: ThreadId,
    nativeId: string,
  ) {
    const rows = yield* sql<{ readonly known_names: string }>`
      SELECT known_names FROM t3f_native_session_names
      WHERE thread_id = ${threadId} AND native_id = ${nativeId}
    `;
    const names = rows[0] === undefined ? undefined : decodeNames(rows[0].known_names);
    return names?._tag === "Some" ? names.value : [];
  });
  return NativeSessionKnownNames.of({
    get,
    add: Effect.fn("NativeSessionKnownNames.add")(function* (threadId, nativeId, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const known = yield* get(threadId, nativeId);
          if (known.at(-1) === trimmed) return;
          const next = [...known.filter((entry) => entry !== trimmed), trimmed].slice(
            -MAX_KNOWN_NAMES,
          );
          const stored = yield* encodeNames(next).pipe(Effect.orDie);
          yield* sql`
            INSERT INTO t3f_native_session_names (thread_id, native_id, known_names)
            VALUES (${threadId}, ${nativeId}, ${stored})
            ON CONFLICT (thread_id) DO UPDATE SET
              native_id = excluded.native_id,
              known_names = excluded.known_names
          `;
        }),
      );
    }),
  });
});

export const layer = Layer.effect(NativeSessionKnownNames, make);
