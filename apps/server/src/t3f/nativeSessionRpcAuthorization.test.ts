import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  mcpClientScopes,
  ProjectId,
  ProviderInstanceId,
  T3F_NATIVE_SESSION_WS_METHODS,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const { identify, list, adopt, handOut, takeBack, subscribeOut } = T3F_NATIVE_SESSION_WS_METHODS;
type NativeSessionTag =
  | typeof identify
  | typeof list
  | typeof adopt
  | typeof handOut
  | typeof takeBack
  | typeof subscribeOut;
const tags: ReadonlyArray<string> = [identify, list, adopt, handOut, takeBack, subscribeOut];
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, NativeSessionTag> =>
      !tags.includes(tag),
  ),
);

const projectId = ProjectId.make("project-1");

const call = (tag: NativeSessionTag, scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handled: Array<string> = [];
    const record = <A>(value: A) => Effect.sync(() => handled.push(tag)).pipe(Effect.as(value));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(identify, () => record({ session: null })),
          group.toLayerHandler(list, () => record({ sessions: [], unlisted: [] })),
          group.toLayerHandler(adopt, () =>
            record({ threadId: ThreadId.make("thread-1"), created: true }),
          ),
          group.toLayerHandler(handOut, () => record({ session: null })),
          group.toLayerHandler(takeBack, () => record({})),
          group.toLayerHandler(subscribeOut, () => Stream.fromEffect(record({ threads: [] }))),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );
    const threadId = ThreadId.make("thread-1");
    const request =
      tag === identify
        ? Effect.asVoid(client[identify]({ threadId }))
        : tag === handOut
          ? Effect.asVoid(client[handOut]({ threadId }))
          : tag === takeBack
            ? Effect.asVoid(client[takeBack]({ threadId }))
            : tag === subscribeOut
              ? Stream.runDrain(client[subscribeOut]({}))
              : tag === list
                ? Effect.asVoid(client[list]({ projectId }))
                : Effect.asVoid(
                    client[adopt]({
                      projectId,
                      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                      nativeId: "5a3356c8-4ff1-46f9-908c-637454f147c4",
                    }),
                  );
    const exit = yield* Effect.exit(request);
    return { exit, handled };
  }).pipe(Effect.scoped);

describe("native session requests", () => {
  it.effect.each([
    { tag: identify, refused: [AuthAccessReadScope], required: AuthOrchestrationReadScope },
    { tag: list, refused: [AuthAccessReadScope], required: AuthOrchestrationReadScope },
    { tag: adopt, refused: mcpClientScopes("read-only"), required: AuthOrchestrationOperateScope },
    {
      tag: handOut,
      refused: mcpClientScopes("read-only"),
      required: AuthOrchestrationOperateScope,
    },
    {
      tag: takeBack,
      refused: mcpClientScopes("read-only"),
      required: AuthOrchestrationOperateScope,
    },
    { tag: subscribeOut, refused: [AuthAccessReadScope], required: AuthOrchestrationReadScope },
  ] as const)(
    "$tag is refused before its handler runs without $required",
    ({ tag, refused, required }) =>
      Effect.gen(function* () {
        const { exit, handled } = yield* call(tag, refused);
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [
              { error: { _tag: "EnvironmentAuthorizationError", requiredPermission: required } },
            ],
          },
        });
        expect(handled).toEqual([]);
      }),
  );

  it.effect.each([
    { tag: identify, scopes: mcpClientScopes("read-only") },
    { tag: list, scopes: mcpClientScopes("read-only") },
    { tag: adopt, scopes: mcpClientScopes("approval-required") },
    { tag: handOut, scopes: mcpClientScopes("approval-required") },
    { tag: takeBack, scopes: mcpClientScopes("approval-required") },
    { tag: subscribeOut, scopes: mcpClientScopes("read-only") },
  ] as const)("$tag is answered for an agent session that holds its scope", ({ tag, scopes }) =>
    Effect.gen(function* () {
      const { exit, handled } = yield* call(tag, scopes);
      expect(exit._tag).toBe("Success");
      expect(handled).toEqual([tag]);
    }),
  );
});
