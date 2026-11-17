import {
  handOutRefusal,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderSessionId,
  T3fNativeSessionError,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { NativeSessionOut } from "./NativeSessionOut.ts";

/**
 * What take-back writes. Turns made in the provider's own client stay in its session while the
 * provider keeps it, so the agent knows them; T3 Code does not import them into the thread.
 */
export const takeBackNotice = (driver: ProviderDriverKind) => {
  const provider = PROVIDER_DISPLAY_NAMES[driver] ?? driver;
  return `Taken back from ${provider}'s client. Turns made there are not shown here.`;
};

const busy = (message: string) => new T3fNativeSessionError({ reason: "busy", message });

const storage = (cause: unknown) =>
  Effect.logWarning("A thread's native session could not be handed out or taken back.", {
    cause,
  }).pipe(
    Effect.andThen(
      Effect.fail(
        new T3fNativeSessionError({
          reason: "storage",
          message: "The thread's native session could not be changed.",
        }),
      ),
    ),
  );

export const makeHandout = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const out = yield* NativeSessionOut;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;

  /** Undefined for a deleted thread. */
  const findRecords = Effect.fn("NativeSessionHandout.findRecords")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.catch(storage));
    if (shell === null || shell.deletedAt !== null) return undefined;
    const { runs, providerThreads } = yield* threads
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
        "runs",
        "providerThreads",
      ])
      .pipe(Effect.catch(storage));
    return { shell, runs, providerThreads };
  });

  const records = (threadId: ThreadId) =>
    findRecords(threadId).pipe(
      Effect.filterOrFail(
        (found) => found !== undefined,
        () =>
          new T3fNativeSessionError({
            reason: "thread_not_found",
            message: `Thread ${threadId} was not found.`,
          }),
      ),
    );

  /**
   * Under the thread's lock no run can start, so a send that races the hand-out lands after
   * the mark and the gate refuses it before any process opens.
   */
  const handOut = Effect.fn("NativeSessionHandout.handOut")(function* (threadId: ThreadId) {
    yield* threadDispatch.withLock(
      threadId,
      Effect.gen(function* () {
        if ((yield* out.get(threadId)) !== undefined) return;
        const { shell, runs, providerThreads } = yield* records(threadId);
        const active = providerThreads.find(
          (providerThread) => providerThread.id === shell.activeProviderThreadId,
        );
        const nativeId = active?.nativeThreadRef?.nativeId;
        if (active === undefined || !nativeId) {
          return yield* new T3fNativeSessionError({
            reason: "no_session",
            message: "This thread has no provider session to hand out yet.",
          });
        }
        const refusal = handOutRefusal(threadId, runs, providerThreads);
        if (refusal !== undefined) return yield* busy(refusal);

        yield* out
          .set({
            threadId,
            driver: active.driver,
            nativeId,
            since: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.catch(storage));

        const sessionIds = new Set<ProviderSessionId>(
          providerThreads.flatMap((providerThread) =>
            providerThread.appThreadId === threadId && providerThread.providerSessionId !== null
              ? [providerThread.providerSessionId]
              : [],
          ),
        );
        const ownProviderThreadIds = providerThreads.flatMap((providerThread) =>
          providerThread.appThreadId === threadId ? [providerThread.id] : [],
        );
        const throughRunOrdinal = runs.reduce((max, run) => Math.max(max, run.ordinal), 0);
        // The agent scope stays: it is T3 Code's own process, not the provider's session.
        const release = Effect.forEach(sessionIds, (providerSessionId) =>
          Effect.gen(function* () {
            if (!(yield* sessions.isLive(providerSessionId))) return true;
            const others = yield* sessions.otherWorkingThreads({ providerSessionId, threadId });
            if (others.length > 0) {
              yield* sessions.detach({ providerSessionId, threadId, detail: "Handed out" });
              return true;
            }
            return yield* sessions.releaseUnlessBusy({
              providerSessionId,
              ownProviderThreadIds,
              throughRunOrdinal,
              reason: "manual_shutdown",
              detail: "Handed out",
            });
          }),
        );
        const released = yield* release.pipe(
          Effect.map((results) => results.every(Boolean)),
          Effect.onError(() => out.clear(threadId).pipe(Effect.ignore)),
          Effect.catch(storage),
        );
        if (!released) {
          yield* out.clear(threadId).pipe(Effect.ignore);
          return yield* busy("The provider's process is busy with another thread. Try again.");
        }
      }),
    );
  });

  const takeBack = Effect.fn("NativeSessionHandout.takeBack")(function* (threadId: ThreadId) {
    yield* threadDispatch.withLock(
      threadId,
      Effect.gen(function* () {
        const mark = yield* out.get(threadId);
        if (mark === undefined) return;
        const found = yield* findRecords(threadId);
        if (found === undefined) {
          yield* out.clear(threadId).pipe(Effect.catch(storage));
          return;
        }
        const { runs } = found;
        // A run's items follow its run; run-less items sit before every run.
        const runId =
          runs.reduce<(typeof runs)[number] | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          )?.id ?? null;
        const now = yield* DateTime.now;
        yield* eventSink
          .write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId }).pipe(Effect.catch(storage)),
                type: "turn-item.updated",
                threadId,
                ...(runId === null ? {} : { runId }),
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`turn-item:native-session-back:${threadId}:${mark.since}`),
                  threadId,
                  runId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  // EventSink allocates the real position.
                  ordinal: 0,
                  status: "completed",
                  title: "Session taken back",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "system_notice",
                  level: "info",
                  message: takeBackNotice(mark.driver),
                },
              },
            ],
          })
          .pipe(Effect.catch(storage));
        yield* out.clear(threadId).pipe(Effect.catch(storage));
      }),
    );
  });

  const outThreads = out.marks.pipe(
    Stream.map((marks) => ({
      threads: marks.map(({ threadId, driver, since }) => ({ threadId, driver, since })),
    })),
  );
  return { handOut, takeBack, outThreads, mark: out.get, dropMark: out.clear };
});
