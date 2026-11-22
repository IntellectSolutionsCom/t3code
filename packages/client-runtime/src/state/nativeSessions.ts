import {
  handOutRefusal,
  T3F_NATIVE_SESSION_WS_METHODS,
  type OrchestrationV2ProviderThread,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderThreadId,
  type T3fNativeSession,
  type T3fNativeSessionIdentifyResult,
  type T3fNativeSessionOutThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import type { ThreadStructure } from "./models.ts";
import {
  type AtomCommandResult,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
  /** The client's own record of the session, for servers that cannot identify it. */
  readonly fallbackNativeId: string | null;
  readonly identify: NativeSessionIdentify | null;
}): NativeSessionRow | null => {
  if (input.identify?.supported === true) {
    const session: T3fNativeSession | null = input.identify.session;
    if (session === null) return null;
    return {
      nativeId: session.nativeId,
      command: session.command,
      commandNote: session.commandNote,
    };
  }
  return input.fallbackNativeId === null
    ? null
    : { nativeId: input.fallbackNativeId, command: null, commandNote: null };
};

export const outThread = (
  threads: ReadonlyArray<T3fNativeSessionOutThread> | null | undefined,
  threadId: ThreadId,
): T3fNativeSessionOutThread | null =>
  threads?.find((thread) => thread.threadId === threadId) ?? null;

/** Why the thread cannot be handed out now, as far as the client's projection shows. */
export const handOutBlocker = (
  projection: Pick<ThreadStructure, "thread" | "runs" | "providerThreads"> | null,
): string | null =>
  projection === null
    ? null
    : (handOutRefusal(projection.thread.id, projection.runs, projection.providerThreads) ?? null);

export const nativeSessionCommandAction = (canHandOut: boolean, isOut: boolean): "copy" | "move" =>
  canHandOut && !isOut ? "move" : "copy";

export const handOutRefusedDescription = (reason: string, resolve: MFunctionType = mFallback) =>
  resolve(
    msg("{reason} Don't run the copied command until the thread is moved to the terminal.", {
      reason,
    }),
  );

export interface TakeBackConfirmation {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

/**
 * Codex refuses a second writer on its session, so taking one back while its client is still
 * open fails safely. Other providers would let both write, so the person closes it first.
 */
const takeBackConfirmation = (
  driver: ProviderDriverKind,
  resolve: MFunctionType,
): TakeBackConfirmation | null =>
  driver === "codex"
    ? null
    : {
        title: resolve(msg("Move back from the terminal?")),
        description: resolve(
          msg(
            "Close the session in the terminal first. Turns made there stay with the agent but are not shown here.",
          ),
        ),
        confirmLabel: resolve(msg("Move back")),
      };

export interface TakeBackInput {
  readonly out: T3fNativeSessionOutThread;
  readonly confirm: (confirmation: TakeBackConfirmation) => Promise<boolean>;
  readonly takeBack: () => Promise<AtomCommandResult<unknown, unknown>>;
}

/** Resolves true once the thread is back, false when the person cancels or the server refuses. */
export async function takeBackThread(
  input: TakeBackInput,
  resolve: MFunctionType = mFallback,
): Promise<boolean> {
  const confirmation = takeBackConfirmation(input.out.driver, resolve);
  if (confirmation !== null && !(await input.confirm(confirmation))) return false;
  return (await input.takeBack())._tag === "Success";
}

/**
 * The one way a client sends to a thread that is out. The server refuses that send, so the
 * thread is taken back first and the message follows; nothing is queued behind the mark.
 */
export async function takeBackAndSend<A>(
  input: TakeBackInput & {
    readonly send: () => Promise<A>;
    /** False once the view shows another thread, so a send that waited goes nowhere else. */
    readonly stillCurrent?: () => boolean;
  },
  resolve: MFunctionType = mFallback,
): Promise<A | undefined> {
  const tookBack = await takeBackThread(input, resolve);
  return tookBack && (input.stillCurrent?.() ?? true) ? input.send() : undefined;
}

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
    /** Read afresh each time it mounts: sessions started outside T3 Code appear without notice. */
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:t3f:native-sessions:list",
      idleTtlMs: 0,
      execute: (input: { readonly projectId: ProjectId }) =>
        request(T3F_NATIVE_SESSION_WS_METHODS.list, input),
    }),
    /** Only for servers whose capabilities say they can hand a thread out. */
    out: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:t3f:native-sessions:out",
      tag: T3F_NATIVE_SESSION_WS_METHODS.subscribeOut,
    }),
    handOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:t3f:native-sessions:hand-out",
      tag: T3F_NATIVE_SESSION_WS_METHODS.handOut,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    takeBack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:t3f:native-sessions:take-back",
      tag: T3F_NATIVE_SESSION_WS_METHODS.takeBack,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    adopt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:t3f:native-sessions:adopt",
      tag: T3F_NATIVE_SESSION_WS_METHODS.adopt,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.providerInstanceId}:${input.nativeId}`,
      },
    }),
  };
}
