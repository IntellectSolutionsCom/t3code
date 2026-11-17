import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** A thread handed out to its provider's own client. */
export interface NativeSessionMark {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly nativeId: string;
  readonly since: string;
}

/**
 * Which threads are out: T3 Code's own record, never read from the provider. A mark only
 * refuses, so a stale one costs a refusal; it is dropped wherever it is seen not to match.
 */
export class NativeSessionOut extends Context.Service<
  NativeSessionOut,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<NativeSessionMark | undefined>;
    readonly set: (mark: NativeSessionMark) => Effect.Effect<void, SqlError.SqlError>;
    /** Succeeds with the mark it removed. */
    readonly clear: (
      threadId: ThreadId,
    ) => Effect.Effect<NativeSessionMark | undefined, SqlError.SqlError>;
    /** The marks now, then after each change. */
    readonly marks: Stream.Stream<ReadonlyArray<NativeSessionMark>>;
  }
>()("t3/t3f/NativeSessionOut") {}

interface MarkRow {
  readonly thread_id: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly native_id: string;
  readonly handed_out_at: string;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  // A copied database brings marks of another environment, and a thread can end or move to
  // another session under a build that ignores marks.
  yield* sql`
    DELETE FROM t3f_native_session_out
    WHERE environment_id <> ${environmentId}
      OR NOT EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_threads AS thread
        JOIN orchestration_v2_projection_provider_threads AS provider_thread
          ON provider_thread.provider_thread_id = thread.active_provider_thread_id
        WHERE thread.thread_id = t3f_native_session_out.thread_id
          AND thread.deleted_at IS NULL
          AND json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId')
            = t3f_native_session_out.native_id
      )
  `;
  const rows = yield* sql<MarkRow>`
    SELECT thread_id, driver, native_id, handed_out_at FROM t3f_native_session_out
  `;
  const marks = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, NativeSessionMark>>(
    new Map(
      rows.map((row) => [
        row.thread_id,
        {
          threadId: row.thread_id,
          driver: row.driver,
          nativeId: row.native_id,
          since: row.handed_out_at,
        },
      ]),
    ),
  );

  const get = (threadId: ThreadId) =>
    SubscriptionRef.get(marks).pipe(Effect.map((current) => current.get(threadId)));

  const set = Effect.fn("NativeSessionOut.set")(function* (mark: NativeSessionMark) {
    yield* sql`
      INSERT INTO t3f_native_session_out (thread_id, environment_id, driver, native_id, handed_out_at)
      VALUES (${mark.threadId}, ${environmentId}, ${mark.driver}, ${mark.nativeId}, ${mark.since})
      ON CONFLICT (thread_id) DO UPDATE SET
        environment_id = excluded.environment_id,
        driver = excluded.driver,
        native_id = excluded.native_id,
        handed_out_at = excluded.handed_out_at
    `;
    yield* SubscriptionRef.update(marks, (current) => new Map(current).set(mark.threadId, mark));
  });

  const clear = Effect.fn("NativeSessionOut.clear")(function* (threadId: ThreadId) {
    const mark = yield* get(threadId);
    if (mark === undefined) return undefined;
    yield* sql`DELETE FROM t3f_native_session_out WHERE thread_id = ${threadId}`;
    yield* SubscriptionRef.update(marks, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
    return mark;
  });

  return NativeSessionOut.of({
    get,
    set,
    clear,
    marks: SubscriptionRef.changes(marks).pipe(Stream.map((current) => [...current.values()])),
  });
});

export const layer = Layer.effect(NativeSessionOut, make);
