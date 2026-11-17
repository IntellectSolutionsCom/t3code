import { PROVIDER_DISPLAY_NAMES, type ProviderThreadId, type ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { type NativeSessionMark, NativeSessionOut } from "./NativeSessionOut.ts";

/**
 * A turn for a thread that is out is refused, not held: it fails as upstream fails a native
 * thread another client is writing, and the queue behind it is not held either.
 */
const refuseWhileOut = (mark: NativeSessionMark, providerThreadId: ProviderThreadId) =>
  new ProviderAdapter.ProviderAdapterThreadInUseError({
    driver: mark.driver,
    providerThreadId,
    detail: `This thread's session is open in ${PROVIDER_DISPLAY_NAMES[mark.driver] ?? mark.driver}'s own client. Take it back here to continue.`,
    cause: `Handed out at ${mark.since}`,
  });

export interface NativeSessionGateMarks {
  readonly get: (threadId: ThreadId) => Effect.Effect<NativeSessionMark | undefined>;
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
        drop: (threadId) => out.value.clear(threadId).pipe(Effect.ignore),
      });
    }),
  ).pipe(Layer.provide(inner));
