import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as NativeSessionOut from "./NativeSessionOut.ts";

const seed = Effect.fn("seed")(function* (input: {
  readonly thread: string;
  readonly nativeId: string;
  readonly deleted?: boolean;
  readonly mark: {
    readonly environment: string;
    readonly nativeId: string;
    readonly takenBackAt?: string;
  };
}) {
  const sql = yield* SqlClient.SqlClient;
  const providerThread = `provider-${input.thread}`;
  const at = "2026-11-16T14:02:00.000Z";
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
      default_provider, runtime_mode, interaction_mode, active_provider_thread_id, created_at,
      updated_at, deleted_at, payload_json)
    VALUES (${input.thread}, 'project', 'title', 'codex', 'full-access', 'default',
      ${providerThread}, ${at}, ${at}, ${input.deleted === true ? at : null}, '{}')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id,
      provider, status, updated_at, payload_json)
    VALUES (${providerThread}, ${input.thread}, 'codex', 'idle', ${at},
      ${JSON.stringify({ nativeThreadRef: { nativeId: input.nativeId } })})
  `;
  yield* sql`
    INSERT INTO t3f_native_session_out
      (thread_id, environment_id, driver, native_id, handed_out_at, taken_back_at)
    VALUES (${input.thread}, ${input.mark.environment}, 'codex', ${input.mark.nativeId},
      ${at}, ${input.mark.takenBackAt ?? null})
  `;
});

const makeOut = NativeSessionOut.make.pipe(
  Effect.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("here")),
    }),
  ),
);

const first = "2026-11-16T15:00:00.000Z";
const second = "2026-11-16T16:00:00.000Z";

it.layer(SqlitePersistence.layerMemory)("NativeSessionOut", (it) => {
  it.effect("drops marks of another environment, a deleted thread, or another session", () =>
    Effect.gen(function* () {
      yield* seed({
        thread: "kept",
        nativeId: "n1",
        mark: { environment: "here", nativeId: "n1" },
      });
      yield* seed({
        thread: "copied",
        nativeId: "n2",
        mark: { environment: "there", nativeId: "n2" },
      });
      yield* seed({
        thread: "deleted",
        nativeId: "n3",
        deleted: true,
        mark: { environment: "here", nativeId: "n3" },
      });
      yield* seed({
        thread: "moved",
        nativeId: "n4",
        mark: { environment: "here", nativeId: "old", takenBackAt: first },
      });
      yield* seed({
        thread: "back",
        nativeId: "n5",
        mark: { environment: "here", nativeId: "n5", takenBackAt: first },
      });

      const out = yield* makeOut;
      assert.equal((yield* out.get(ThreadId.make("kept")))?.nativeId, "n1");
      for (const thread of ["copied", "deleted", "moved"]) {
        assert.isUndefined(yield* out.get(ThreadId.make(thread)));
      }
      assert.isUndefined(yield* out.get(ThreadId.make("back")));
      assert.equal((yield* out.getTakeBack(ThreadId.make("back")))?.takenBackAt, first);
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql<{
          thread_id: string;
        }>`SELECT thread_id FROM t3f_native_session_out ORDER BY thread_id`,
        [{ thread_id: "back" }, { thread_id: "kept" }],
      );
    }),
  );

  it.effect("records a take-back and replaces it after another hand-out", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const out = yield* makeOut;
      const mark = {
        threadId: ThreadId.make("repeat"),
        nativeId: "native-repeat",
        driver: ProviderDriverKind.make("codex"),
        since: "2026-11-16T14:02:00.000Z",
      };
      const readTakenBackAt = sql<{ taken_back_at: string | null }>`
        SELECT taken_back_at FROM t3f_native_session_out WHERE thread_id = ${mark.threadId}
      `.pipe(Effect.map((rows) => rows[0]?.taken_back_at));

      yield* out.set(mark);
      yield* out.takeBack(mark.threadId, first);
      assert.isUndefined(yield* out.get(mark.threadId));
      assert.isFalse(
        Option.getOrThrow(yield* Stream.runHead(out.marks)).some(
          (active) => active.threadId === mark.threadId,
        ),
      );
      assert.equal(yield* readTakenBackAt, first);
      assert.isUndefined(yield* out.clear(mark.threadId));
      assert.equal(yield* readTakenBackAt, first);

      yield* out.set({ ...mark, since: "2026-11-16T15:30:00.000Z" });
      assert.equal(yield* readTakenBackAt, null);
      assert.isUndefined(yield* out.getTakeBack(mark.threadId));
      yield* out.takeBack(mark.threadId, second);
      assert.equal(yield* readTakenBackAt, second);
      assert.equal((yield* out.getTakeBack(mark.threadId))?.takenBackAt, second);
    }),
  );
});
