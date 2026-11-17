import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import type { OrchestrationV2ProviderThread, OrchestrationV2Run } from "../orchestrationV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";

export const T3F_NATIVE_SESSION_WS_METHODS = {
  identify: "t3f.nativeSessions.identify",
  list: "t3f.nativeSessions.list",
  adopt: "t3f.nativeSessions.adopt",
  handOut: "t3f.nativeSessions.handOut",
  takeBack: "t3f.nativeSessions.takeBack",
  subscribeOut: "t3f.nativeSessions.subscribeOut",
} as const;

// The server's active run statuses; a run in any of them still writes to the session.
const WORKING_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "preparing",
  "starting",
  "running",
  "waiting",
];

/**
 * Why a thread cannot be handed out now: nothing may be running or waiting to run on it.
 * The server refuses on it, and clients disable the hand-out from the projection they hold.
 */
export const handOutRefusal = (
  threadId: ThreadId,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
  providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "appThreadId" | "pendingBackgroundTasks">
  >,
): string | undefined => {
  if (runs.some((run) => WORKING_RUN_STATUSES.includes(run.status))) {
    return "A turn is running. Stop it or wait for it to finish.";
  }
  if (runs.some((run) => run.status === "queued")) {
    return "Messages are queued. Send or remove them first.";
  }
  if (
    providerThreads.some(
      (providerThread) =>
        providerThread.appThreadId === threadId &&
        (providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
    )
  ) {
    return "Background tasks are still running. Stop them or wait.";
  }
  return undefined;
};

/** The thread was handed out to the provider's own client; T3 Code refuses its turns until taken back. */
export const T3fNativeSessionOut = Schema.Struct({ since: IsoDateTime });
export type T3fNativeSessionOut = typeof T3fNativeSessionOut.Type;

/** The provider's own session behind a thread, and how to continue it in the provider's client. */
export const T3fNativeSession = Schema.Struct({
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  nativeId: TrimmedNonEmptyString,
  /** The name the provider's own client shows, when T3 Code can read one. */
  name: Schema.NullOr(TrimmedNonEmptyString),
  cwd: TrimmedNonEmptyString,
  /** A command for the shell of the machine this environment runs on. */
  command: Schema.NullOr(TrimmedNonEmptyString),
  /** Why there is no command. */
  commandNote: Schema.NullOr(TrimmedNonEmptyString),
  /** Absent from servers that cannot hand a thread out. */
  out: Schema.optionalKey(Schema.NullOr(T3fNativeSessionOut)),
});
export type T3fNativeSession = typeof T3fNativeSession.Type;

export const T3fNativeSessionIdentifyInput = Schema.Struct({ threadId: ThreadId });
export type T3fNativeSessionIdentifyInput = typeof T3fNativeSessionIdentifyInput.Type;

export const T3fNativeSessionIdentifyResult = Schema.Struct({
  /** Null until the thread's provider has opened a session. */
  session: Schema.NullOr(T3fNativeSession),
});
export type T3fNativeSessionIdentifyResult = typeof T3fNativeSessionIdentifyResult.Type;

export class T3fNativeSessionError extends Schema.TaggedError<T3fNativeSessionError>()(
  "T3fNativeSessionError",
  {
    reason: Schema.Literals([
      "thread_not_found",
      "project_not_found",
      "instance_not_found",
      "unsupported",
      "session_not_found",
      "owned_by_deleted_thread",
      "no_session",
      "busy",
      "storage",
    ]),
    message: Schema.String,
  },
) {}

export const T3fNativeSessionIdentifyRpc = Rpc.make(T3F_NATIVE_SESSION_WS_METHODS.identify, {
  payload: T3fNativeSessionIdentifyInput,
  success: T3fNativeSessionIdentifyResult,
  error: Schema.Union([T3fNativeSessionError, EnvironmentAuthorizationError]),
});

export const T3fNativeSessionListInput = Schema.Struct({ projectId: ProjectId });
export type T3fNativeSessionListInput = typeof T3fNativeSessionListInput.Type;

/** A provider session that ran in the project's folder. */
export const T3fNativeSessionListItem = Schema.Struct({
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  nativeId: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
  /** The thread that already runs on this session. */
  threadId: Schema.NullOr(ThreadId),
  /** A deleted thread holds this session, so it cannot be loaded into a new one. */
  threadDeleted: Schema.Boolean,
});
export type T3fNativeSessionListItem = typeof T3fNativeSessionListItem.Type;

/** An agent asked for its sessions that gave none in time, so some may be missing. */
export const T3fNativeSessionUnlisted = Schema.Struct({
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  reason: Schema.Literals(["timed_out", "failed"]),
});
export type T3fNativeSessionUnlisted = typeof T3fNativeSessionUnlisted.Type;

export const T3fNativeSessionListResult = Schema.Struct({
  sessions: Schema.Array(T3fNativeSessionListItem),
  unlisted: Schema.Array(T3fNativeSessionUnlisted),
});
export type T3fNativeSessionListResult = typeof T3fNativeSessionListResult.Type;

export const T3fNativeSessionAdoptInput = Schema.Struct({
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  nativeId: TrimmedNonEmptyString,
});
export type T3fNativeSessionAdoptInput = typeof T3fNativeSessionAdoptInput.Type;

export const T3fNativeSessionAdoptResult = Schema.Struct({
  threadId: ThreadId,
  /** False when a thread already ran on the session; that thread is returned. */
  created: Schema.Boolean,
});
export type T3fNativeSessionAdoptResult = typeof T3fNativeSessionAdoptResult.Type;

export const T3fNativeSessionListRpc = Rpc.make(T3F_NATIVE_SESSION_WS_METHODS.list, {
  payload: T3fNativeSessionListInput,
  success: T3fNativeSessionListResult,
  error: Schema.Union([T3fNativeSessionError, EnvironmentAuthorizationError]),
});

export const T3fNativeSessionAdoptRpc = Rpc.make(T3F_NATIVE_SESSION_WS_METHODS.adopt, {
  payload: T3fNativeSessionAdoptInput,
  success: T3fNativeSessionAdoptResult,
  error: Schema.Union([T3fNativeSessionError, EnvironmentAuthorizationError]),
});

export const T3fNativeSessionThreadInput = Schema.Struct({ threadId: ThreadId });
export type T3fNativeSessionThreadInput = typeof T3fNativeSessionThreadInput.Type;

export const T3fNativeSessionHandOutRpc = Rpc.make(T3F_NATIVE_SESSION_WS_METHODS.handOut, {
  payload: T3fNativeSessionThreadInput,
  success: T3fNativeSessionIdentifyResult,
  error: Schema.Union([T3fNativeSessionError, EnvironmentAuthorizationError]),
});

export const T3fNativeSessionTakeBackRpc = Rpc.make(T3F_NATIVE_SESSION_WS_METHODS.takeBack, {
  payload: T3fNativeSessionThreadInput,
  success: Schema.Struct({}),
  error: Schema.Union([T3fNativeSessionError, EnvironmentAuthorizationError]),
});

/** A thread of this environment that is out, and since when. */
export const T3fNativeSessionOutThread = Schema.Struct({
  threadId: ThreadId,
  driver: ProviderDriverKind,
  since: IsoDateTime,
});
export type T3fNativeSessionOutThread = typeof T3fNativeSessionOutThread.Type;

/** The threads of this environment that are out, now and after each change. */
export const T3fNativeSessionOutThreads = Schema.Struct({
  threads: Schema.Array(T3fNativeSessionOutThread),
});
export type T3fNativeSessionOutThreads = typeof T3fNativeSessionOutThreads.Type;

export const T3fNativeSessionSubscribeOutRpc = Rpc.make(
  T3F_NATIVE_SESSION_WS_METHODS.subscribeOut,
  {
    payload: Schema.Struct({}),
    success: T3fNativeSessionOutThreads,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);
