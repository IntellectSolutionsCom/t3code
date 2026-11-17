import {
  checkThreadBadge,
  T3fThreadBadgeError,
  type T3fThreadBadge,
  type T3fThreadBadgeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export class ThreadBadges extends Context.Service<
  ThreadBadges,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<T3fThreadBadge | null, T3fThreadBadgeError>;
    /** Sets, replaces or (with `null`) clears. Setting needs a live thread; clearing never does. */
    readonly set: (
      threadId: ThreadId,
      badge: T3fThreadBadge | null,
    ) => Effect.Effect<T3fThreadBadge | null, T3fThreadBadgeError>;
    /** Every badge now, then each change after it. Badges are the only ids it carries. */
    readonly subscribe: Stream.Stream<T3fThreadBadgeEvent, T3fThreadBadgeError>;
  }
>()("t3/t3f/ThreadBadges") {}

const segmenter = new Intl.Segmenter();
const countGraphemes = (text: string) => Array.from(segmenter.segment(text)).length;

const storageError = (cause: unknown) =>
  Effect.logWarning("Thread badges could not be read or written.", { cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new T3fThreadBadgeError({
          reason: "storage",
          message: "Thread badges could not be read or saved.",
        }),
      ),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.unbounded<T3fThreadBadgeEvent>();
  // Writes and the snapshot-and-subscribe step take turns, so a change lands in the snapshot or after it, never between.
  const turn = yield* Semaphore.make(1);

  const read = (threadId: ThreadId) =>
    sql<T3fThreadBadge>`
      SELECT symbol, label FROM t3f_thread_badges WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map(([row]) => (row === undefined ? null : { symbol: row.symbol, label: row.label })),
      Effect.catch(storageError),
    );

  // Badges live in our table with no link to the thread, so a deleted thread's row is hidden, not removed.
  const isLive = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell !== null && shell.deletedAt === null),
      Effect.catch(storageError),
    );

  const get: ThreadBadges["Service"]["get"] = Effect.fn("ThreadBadges.get")(function* (threadId) {
    return (yield* isLive(threadId)) ? yield* read(threadId) : null;
  });

  const set: ThreadBadges["Service"]["set"] = Effect.fn("ThreadBadges.set")(
    function* (threadId, requested) {
      const checked = requested === null ? undefined : checkThreadBadge(requested, countGraphemes);
      if (checked?.ok === false) {
        return yield* new T3fThreadBadgeError({ reason: checked.reason, message: checked.message });
      }
      const badge = checked?.badge ?? null;
      if (badge !== null) {
        if (!(yield* isLive(threadId))) {
          return yield* new T3fThreadBadgeError({
            reason: "thread_not_found",
            message: "That thread no longer exists.",
          });
        }
      }
      yield* (
        badge === null
          ? sql`DELETE FROM t3f_thread_badges WHERE thread_id = ${threadId}`
          : sql`
              INSERT INTO t3f_thread_badges (thread_id, symbol, label)
              VALUES (${threadId}, ${badge.symbol}, ${badge.label})
              ON CONFLICT (thread_id) DO UPDATE SET symbol = excluded.symbol, label = excluded.label
            `
      ).pipe(
        Effect.andThen(
          Ref.updateAndGet(revision, (current) => current + 1).pipe(
            Effect.flatMap((next) =>
              PubSub.publish(changes, { type: "changed", revision: next, threadId, badge }),
            ),
          ),
        ),
        Effect.catch(storageError),
        turn.withPermit,
      );
      return badge;
    },
  );

  const subscribe: ThreadBadges["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribing and reading take the same turn as a write, so no change falls between them.
      const { subscription, snapshot } = yield* Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const rows = yield* sql<{
          readonly thread_id: ThreadId;
          readonly symbol: string;
          readonly label: string;
        }>`SELECT thread_id, symbol, label FROM t3f_thread_badges ORDER BY thread_id`.pipe(
          Effect.catch(storageError),
        );
        const live = yield* Effect.filter(rows, ({ thread_id }) => isLive(thread_id), {
          concurrency: 8,
        });
        const snapshot = {
          type: "snapshot",
          revision: yield* Ref.get(revision),
          badges: live.map(({ thread_id, symbol, label }) => ({
            threadId: thread_id,
            symbol,
            label,
          })),
        } satisfies T3fThreadBadgeEvent;
        return { subscription, snapshot };
      }).pipe(turn.withPermit);
      return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
    }),
  );

  return ThreadBadges.of({ get, set, subscribe });
});

export const layer = Layer.effect(ThreadBadges, make);
