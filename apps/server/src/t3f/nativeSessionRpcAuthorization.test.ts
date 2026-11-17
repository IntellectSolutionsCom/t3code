import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  mcpClientScopes,
  T3F_NATIVE_SESSION_WS_METHODS,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const identify = T3F_NATIVE_SESSION_WS_METHODS.identify;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof identify> =>
      tag !== identify,
  ),
);

const call = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handled: Array<string> = [];
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          group.toLayerHandler(identify, () =>
            Effect.sync(() => handled.push("identify")).pipe(Effect.as({ session: null })),
          ),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );
    const exit = yield* client[identify]({ threadId: ThreadId.make("thread-1") }).pipe(Effect.exit);
    return { exit, handled };
  }).pipe(Effect.scoped);

describe("identifying a native session", () => {
  it.effect("is refused before the handler runs to a session that cannot read threads", () =>
    Effect.gen(function* () {
      const { exit, handled } = yield* call([AuthAccessReadScope]);
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              error: {
                _tag: "EnvironmentAuthorizationError",
                requiredPermission: AuthOrchestrationReadScope,
              },
            },
          ],
        },
      });
      expect(handled).toEqual([]);
    }),
  );

  it.effect("is answered for a read-only agent session", () =>
    Effect.gen(function* () {
      const { exit, handled } = yield* call(mcpClientScopes("read-only"));
      expect(exit._tag).toBe("Success");
      expect(handled).toEqual(["identify"]);
    }),
  );
});
