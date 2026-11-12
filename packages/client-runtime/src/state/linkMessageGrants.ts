import { T3F_WS_METHODS, type T3fLinkMessageGrantsListResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

export type LinkMessageGrants =
  | ({ readonly supported: true } & T3fLinkMessageGrantsListResult)
  | { readonly supported: false };

/** A server without grants answers their list with this defect; its settings show no switch. */
export const orUnsupported = <E, R>(
  list: Effect.Effect<T3fLinkMessageGrantsListResult, E, R>,
): Effect.Effect<LinkMessageGrants, E, R> =>
  list.pipe(
    Effect.map((result): LinkMessageGrants => ({ supported: true, ...result })),
    Effect.catchDefect((defect) =>
      defect === `Unknown request tag: ${T3F_WS_METHODS.linkMessageGrantsList}`
        ? Effect.succeed<LinkMessageGrants>({ supported: false })
        : Effect.die(defect),
    ),
  );

export function createLinkMessageGrantAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:t3f:link-message-grants:list",
    execute: (input: Record<string, never>) =>
      orUnsupported(request(T3F_WS_METHODS.linkMessageGrantsList, input)),
  });
  return {
    list,
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:t3f:link-message-grants:set",
      tag: T3F_WS_METHODS.linkMessageGrantsSet,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
  };
}
