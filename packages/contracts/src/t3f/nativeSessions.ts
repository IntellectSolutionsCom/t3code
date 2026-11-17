import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";

export const T3F_NATIVE_SESSION_WS_METHODS = {
  identify: "t3f.nativeSessions.identify",
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
    reason: Schema.Literals(["thread_not_found", "storage"]),
    message: Schema.String,
  },
) {}

export const T3fNativeSessionIdentifyRpc = Rpc.make(T3F_NATIVE_SESSION_WS_METHODS.identify, {
  payload: T3fNativeSessionIdentifyInput,
  success: T3fNativeSessionIdentifyResult,
  error: Schema.Union([T3fNativeSessionError, EnvironmentAuthorizationError]),
});
