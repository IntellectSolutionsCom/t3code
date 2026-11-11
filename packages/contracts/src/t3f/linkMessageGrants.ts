import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { AuthSessionId } from "../baseSchemas.ts";

export const T3F_WS_METHODS = {
  linkMessageGrantsList: "t3f.linkMessageGrants.list",
  linkMessageGrantsSet: "t3f.linkMessageGrants.set",
} as const;

/** A linked environment's session here, and whether its agents may send messages to threads here. */
export const T3fLinkMessageGrant = Schema.Struct({
  sessionId: AuthSessionId,
  granted: Schema.Boolean,
});
export type T3fLinkMessageGrant = typeof T3fLinkMessageGrant.Type;

export const T3fLinkMessageGrantsListResult = Schema.Struct({
  links: Schema.Array(T3fLinkMessageGrant),
  /** Agent sessions below full access issued before links were recorded here: possibly links. */
  unconfirmed: Schema.Array(AuthSessionId),
});
export type T3fLinkMessageGrantsListResult = typeof T3fLinkMessageGrantsListResult.Type;

export const T3fLinkMessageGrantSetInput = Schema.Struct({
  sessionId: AuthSessionId,
  granted: Schema.Boolean,
});
export type T3fLinkMessageGrantSetInput = typeof T3fLinkMessageGrantSetInput.Type;

export class T3fLinkMessageGrantError extends Schema.TaggedError<T3fLinkMessageGrantError>()(
  "T3fLinkMessageGrantError",
  {
    reason: Schema.Literals(["not_a_link", "storage"]),
    message: Schema.String,
  },
) {}

export const T3fLinkMessageGrantsListRpc = Rpc.make(T3F_WS_METHODS.linkMessageGrantsList, {
  payload: Schema.Struct({}),
  success: T3fLinkMessageGrantsListResult,
  error: Schema.Union([T3fLinkMessageGrantError, EnvironmentAuthorizationError]),
});

export const T3fLinkMessageGrantsSetRpc = Rpc.make(T3F_WS_METHODS.linkMessageGrantsSet, {
  payload: T3fLinkMessageGrantSetInput,
  success: Schema.Struct({ granted: Schema.Boolean }),
  error: Schema.Union([T3fLinkMessageGrantError, EnvironmentAuthorizationError]),
});
