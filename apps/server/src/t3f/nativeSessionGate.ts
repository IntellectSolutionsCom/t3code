import {
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { type NativeSessionMark, NativeSessionOut } from "./NativeSessionOut.ts";
import {
  crossedTakeBackMessage,
  NativeSessionRestoreRefusedError,
} from "./NativeSessionRestoreRefusedError.ts";

/**
 * A turn for a thread that is out is refused, not held: it fails as upstream fails a native
 * thread another client is writing, and the queue behind it is not held either.
 */
const refuseWhileOut = (mark: NativeSessionMark, providerThreadId: ProviderThreadId) =>
  new ProviderAdapter.ProviderAdapterThreadInUseError({
    driver: mark.driver,
    providerThreadId,
    detail: "This thread's session is in the terminal. Move it back here to continue.",
    cause: `Handed out at ${mark.since}`,
  });

const exactRewindDrivers = new Set([ProviderDriverKind.make("claude")]);

interface NativeSessionGateMarks {
  readonly get: (threadId: ThreadId) => Effect.Effect<NativeSessionMark | undefined>;
  readonly getTakeBack: NativeSessionOut["Service"]["getTakeBack"];
  /** Removes a mark the thread no longer matches. */
  readonly drop: (threadId: ThreadId) => Effect.Effect<void>;
}

/**
 * Refuses every session T3 Code would open or resume for a thread that is out. It sits ahead of
 * the manager's loaded-thread shortcut, and refuses at open because some agents load the native
 * session there.
 */
export const makeGate = Effect.fn("NativeSessionGate.make")(function* (
  manager: ProviderSessionManager.ProviderSessionManagerV2Shape,
  marks: NativeSessionGateMarks,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const markFor = (threadId: ThreadId | undefined) =>
    threadId === undefined ? Effect.undefined : marks.get(threadId);

  const crossesTakeBack = Effect.fn("NativeSessionGate.crossesTakeBack")(function* (
    providerThread: OrchestrationV2ProviderThread,
    startedAt: DateTime.Utc | null,
  ) {
    const { appThreadId, driver, nativeThreadRef } = providerThread;
    if (
      appThreadId === null ||
      nativeThreadRef?.nativeId == null ||
      exactRewindDrivers.has(driver)
    ) {
      return false;
    }
    const takeBack = yield* marks.getTakeBack(appThreadId);
    return (
      takeBack !== undefined &&
      takeBack.driver === driver &&
      takeBack.nativeId === nativeThreadRef.nativeId &&
      (startedAt === null || DateTime.toEpochMillis(startedAt) < Date.parse(takeBack.takenBackAt))
    );
  });

  const gateRuntime = (
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  ): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
    ...runtime,
    ensureThread: (input) =>
      markFor(input.threadId).pipe(
        Effect.flatMap((mark) =>
          mark === undefined || input.existingProviderThread === undefined
            ? runtime.ensureThread(input)
            : Effect.fail(refuseWhileOut(mark, input.existingProviderThread.id)),
        ),
      ),
    resumeThread: (input) =>
      markFor(input.threadId ?? input.providerThread.appThreadId ?? undefined).pipe(
        Effect.flatMap((mark) =>
          mark === undefined
            ? runtime.resumeThread(input)
            : Effect.fail(refuseWhileOut(mark, input.providerThread.id)),
        ),
      ),
    rollbackThread: Effect.fn("NativeSessionGate.rollbackThread")(function* (input) {
      const { providerThread, target } = input;
      const startedAt = target.type === "thread_start" ? null : target.providerTurn.startedAt;
      if (yield* crossesTakeBack(providerThread, startedAt)) {
        return yield* new NativeSessionRestoreRefusedError({
          driver: providerThread.driver,
          providerThreadId: providerThread.id,
          checkpointId: target.checkpointId,
        });
      }
      return yield* runtime.rollbackThread(input);
    }),
    forkThread: Effect.fn("NativeSessionGate.forkThread")(function* (input) {
      const { sourceProviderThread, sourceProviderTurns, providerTurnId } = input;
      if (providerTurnId !== undefined) {
        const target = sourceProviderTurns?.find(
          (turn) => turn.id === providerTurnId && turn.providerThreadId === sourceProviderThread.id,
        );
        if (yield* crossesTakeBack(sourceProviderThread, target?.startedAt ?? null)) {
          return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
            driver: sourceProviderThread.driver,
            providerThreadId: sourceProviderThread.id,
            cause: crossedTakeBackMessage("fork"),
          });
        }
      }
      return yield* runtime.forkThread(input);
    }),
  });

  const open = Effect.fn("NativeSessionGate.open")(function* (
    input: Parameters<ProviderSessionManager.ProviderSessionManagerV2Shape["open"]>[0],
  ) {
    const mark = yield* marks.get(input.threadId);
    if (mark !== undefined) {
      const shell = yield* projections
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const providerThreadId = shell?.activeProviderThreadId ?? null;
      if (providerThreadId === null || mark.nativeId !== input.initialNativeThreadId) {
        yield* marks.drop(input.threadId);
      } else {
        return yield* new ProviderSessionManager.ProviderSessionOpenError({
          instanceId: input.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
          cause: refuseWhileOut(mark, providerThreadId),
        });
      }
    }
    return gateRuntime(yield* manager.open(input));
  });

  return ProviderSessionManager.ProviderSessionManagerV2.of({
    ...manager,
    open,
    get: Effect.fn("NativeSessionGate.get")(function* (providerSessionId) {
      return Option.map(yield* manager.get(providerSessionId), gateRuntime);
    }),
  });
});

/**
 * Puts the gate over a session manager layer, with marks from {@link NativeSessionOut}. The
 * server provides the marks; runtimes built without them, as in upstream's tests, have no gate.
 */
export const layerOver = <E, R>(
  inner: Layer.Layer<ProviderSessionManager.ProviderSessionManagerV2, E, R>,
) =>
  Layer.effect(
    ProviderSessionManager.ProviderSessionManagerV2,
    Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const out = yield* Effect.serviceOption(NativeSessionOut);
      if (Option.isNone(out)) return manager;
      return yield* makeGate(manager, {
        get: out.value.get,
        getTakeBack: out.value.getTakeBack,
        drop: (threadId) => out.value.clear(threadId).pipe(Effect.ignore),
      });
    }),
  ).pipe(Layer.provide(inner));
