import {
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** Providers whose clients name a session on disk, in a form the readers parse. */
const NAMED_DRIVERS = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);

/** The native id of a session whose name T3 Code can read, if the provider thread has one. */
export const namedSessionId = (providerThread: OrchestrationV2ProviderThread | undefined) =>
  providerThread !== undefined && NAMED_DRIVERS.has(providerThread.driver)
    ? (providerThread.nativeThreadRef?.nativeId ?? undefined)
    : undefined;

/** Resolves to the name the thread was renamed to when the session's own name won. */
type SyncNativeName = (threadId: ThreadId) => Effect.Effect<string | undefined>;

/**
 * The gate sits under the orchestrator, so it cannot depend on the services that dispatch a
 * rename. The session service binds the step once they exist.
 */
export class NativeSessionTitleSync extends Context.Service<
  NativeSessionTitleSync,
  {
    readonly sync: SyncNativeName;
    readonly bind: (sync: SyncNativeName) => Effect.Effect<void>;
  }
>()("t3/t3f/NativeSessionTitleSync") {}

export const make = Effect.gen(function* () {
  const bound = yield* Ref.make<SyncNativeName | undefined>(undefined);
  return NativeSessionTitleSync.of({
    sync: Effect.fn("NativeSessionTitleSync.sync")(function* (threadId) {
      const sync = yield* Ref.get(bound);
      return sync === undefined ? undefined : yield* sync(threadId);
    }),
    bind: Effect.fn("NativeSessionTitleSync.bind")(function* (sync) {
      yield* Ref.set(bound, sync);
    }),
  });
});

export const layer = Layer.effect(NativeSessionTitleSync, make);
