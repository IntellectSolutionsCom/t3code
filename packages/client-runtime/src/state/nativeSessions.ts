import {
  T3F_NATIVE_SESSION_WS_METHODS,
  type OrchestrationV2ProviderThread,
  type ProviderThreadId,
  type T3fNativeSession,
  type T3fNativeSessionIdentifyResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

export type NativeSessionIdentify =
  | ({ readonly supported: true } & T3fNativeSessionIdentifyResult)
  | { readonly supported: false };

/** A server without native sessions answers with this defect; the row falls back to the thread's own record. */
export const orUnsupported = <E, R>(
  identify: Effect.Effect<T3fNativeSessionIdentifyResult, E, R>,
): Effect.Effect<NativeSessionIdentify, E, R> =>
  identify.pipe(
    Effect.map((result): NativeSessionIdentify => ({ supported: true, ...result })),
    Effect.catchDefect((defect) =>
      defect === `Unknown request tag: ${T3F_NATIVE_SESSION_WS_METHODS.identify}`
        ? Effect.succeed<NativeSessionIdentify>({ supported: false })
        : Effect.die(defect),
    ),
  );

export interface NativeSessionRow {
  readonly nativeId: string;
  /** Shown only when it differs from the thread's title. */
  readonly name: string | null;
  readonly command: string | null;
  readonly commandNote: string | null;
}

export const activeNativeId = (
  activeProviderThreadId: ProviderThreadId | null,
  providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">>,
): string | null =>
  providerThreads.find((providerThread) => providerThread.id === activeProviderThreadId)
    ?.nativeThreadRef?.nativeId ?? null;

export const nativeSessionRow = (input: {
  readonly title: string;
  /** The client's own record of the session, for servers that cannot identify it. */
  readonly fallbackNativeId: string | null;
  readonly identify: NativeSessionIdentify | null;
}): NativeSessionRow | null => {
  if (input.identify?.supported === true) {
    const session: T3fNativeSession | null = input.identify.session;
    if (session === null) return null;
    return {
      nativeId: session.nativeId,
      name: session.name !== null && session.name !== input.title.trim() ? session.name : null,
      command: session.command,
      commandNote: session.commandNote,
    };
  }
  return input.fallbackNativeId === null
    ? null
    : { nativeId: input.fallbackNativeId, name: null, command: null, commandNote: null };
};

export function createNativeSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** `nativeId` is the client's view of the session, so a new session refetches. */
    identify: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:t3f:native-sessions:identify",
      execute: (input: { readonly threadId: ThreadId; readonly nativeId: string | null }) =>
        orUnsupported(
          request(T3F_NATIVE_SESSION_WS_METHODS.identify, { threadId: input.threadId }),
        ),
    }),
  };
}
