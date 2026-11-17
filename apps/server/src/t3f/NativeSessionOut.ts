import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

interface NativeSessionTakeBack extends NativeSessionMark {
  readonly takenBackAt: string;
}

interface NativeSessionState {
  readonly mark: NativeSessionMark;
  readonly takenBackAt: string | null;
}

/** The current hand-out or last take-back for a thread's native session. */
export class NativeSessionOut extends Context.Service<
  NativeSessionOut,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<NativeSessionMark | undefined>;
    readonly set: (mark: NativeSessionMark) => Effect.Effect<void, SqlError.SqlError>;
    readonly getTakeBack: (threadId: ThreadId) => Effect.Effect<NativeSessionTakeBack | undefined>;
    readonly takeBack: (
      threadId: ThreadId,
      takenBackAt: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /** Removes an active hand-out. */
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
  readonly taken_back_at: string | null;
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
    SELECT thread_id, driver, native_id, handed_out_at, taken_back_at FROM t3f_native_session_out
  `;
  const marks = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, NativeSessionState>>(
    new Map(
      rows.map((row) => [
        row.thread_id,
        {
          mark: {
            threadId: row.thread_id,
            driver: row.driver,
            nativeId: row.native_id,
            since: row.handed_out_at,
          },
          takenBackAt: row.taken_back_at,
        },
      ]),
    ),
  );

  const get = (threadId: ThreadId) =>
    SubscriptionRef.get(marks).pipe(
      Effect.map((current) => {
        const state = current.get(threadId);
        return state?.takenBackAt === null ? state.mark : undefined;
      }),
    );

  const getTakeBack = (threadId: ThreadId) =>
    SubscriptionRef.get(marks).pipe(
      Effect.map((current) => {
        const state = current.get(threadId);
        return state === undefined || state.takenBackAt === null
          ? undefined
          : { ...state.mark, takenBackAt: state.takenBackAt };
      }),
    );

  const set = Effect.fn("NativeSessionOut.set")(function* (mark: NativeSessionMark) {
    yield* SubscriptionRef.updateEffect(marks, (current) =>
      sql`
        INSERT INTO t3f_native_session_out (thread_id, environment_id, driver, native_id, handed_out_at)
        VALUES (${mark.threadId}, ${environmentId}, ${mark.driver}, ${mark.nativeId}, ${mark.since})
        ON CONFLICT (thread_id) DO UPDATE SET
          environment_id = excluded.environment_id,
          driver = excluded.driver,
          native_id = excluded.native_id,
          handed_out_at = excluded.handed_out_at,
          taken_back_at = NULL
      `.pipe(Effect.map(() => new Map(current).set(mark.threadId, { mark, takenBackAt: null }))),
    );
  }, Effect.uninterruptible);

  const takeBack = Effect.fn("NativeSessionOut.takeBack")(function* (
    threadId: ThreadId,
    takenBackAt: string,
  ) {
    yield* SubscriptionRef.modifySomeEffect(marks, (current) => {
      const state = current.get(threadId);
      if (state?.takenBackAt !== null) return Effect.succeed([undefined, Option.none()] as const);
      return sql`
        UPDATE t3f_native_session_out SET taken_back_at = ${takenBackAt}
        WHERE thread_id = ${threadId} AND taken_back_at IS NULL
      `.pipe(
        Effect.map(
          () =>
            [
              undefined,
              Option.some(new Map(current).set(threadId, { mark: state.mark, takenBackAt })),
            ] as const,
        ),
      );
    });
  }, Effect.uninterruptible);

  const clear = Effect.fn("NativeSessionOut.clear")(function* (threadId: ThreadId) {
    return yield* SubscriptionRef.modifySomeEffect(marks, (current) => {
      const state = current.get(threadId);
      if (state?.takenBackAt !== null) {
        return Effect.succeed([undefined, Option.none()] as const);
      }
      return sql`
        DELETE FROM t3f_native_session_out WHERE thread_id = ${threadId} AND taken_back_at IS NULL
      `.pipe(
        Effect.map(() => {
          const next = new Map(current);
          next.delete(threadId);
          return [state.mark, Option.some(next)] as const;
        }),
      );
    });
  }, Effect.uninterruptible);

  return NativeSessionOut.of({
    get,
    getTakeBack,
    set,
    takeBack,
    clear,
    marks: SubscriptionRef.changes(marks).pipe(
      Stream.map((current) =>
        [...current.values()].flatMap(({ mark, takenBackAt }) =>
          takenBackAt === null ? [mark] : [],
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(NativeSessionOut, make);
