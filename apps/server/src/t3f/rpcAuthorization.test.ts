import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  mcpClientScopes,
  T3F_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof T3F_WS_METHODS.linkMessageGrantsSet
    > => tag !== T3F_WS_METHODS.linkMessageGrantsSet,
  ),
);

describe("setting a link message grant", () => {
  it.effect.each([
    {
      who: "a session that may revoke clients but not start work",
      scopes: [AuthAccessReadScope, AuthAccessWriteScope],
      missing: AuthOrchestrationOperateScope,
    },
    {
      who: "a full-access linked agent session",
      scopes: mcpClientScopes("full-access"),
      missing: AuthAccessWriteScope,
    },
  ])("is refused to $who before the handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayerHandler(T3F_WS_METHODS.linkMessageGrantsSet, ({ granted }) =>
              Effect.sync(() => handled.push("set")).pipe(Effect.as({ granted })),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      const refused = yield* client[T3F_WS_METHODS.linkMessageGrantsSet]({
        sessionId: AuthSessionId.make("link"),
        granted: true,
      }).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
