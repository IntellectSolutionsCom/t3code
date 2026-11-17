import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";

export const T3F_NATIVE_SESSION_WS_METHODS = {
  identify: "t3f.nativeSessions.identify",
  list: "t3f.nativeSessions.list",
  adopt: "t3f.nativeSessions.adopt",
} as const;

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
