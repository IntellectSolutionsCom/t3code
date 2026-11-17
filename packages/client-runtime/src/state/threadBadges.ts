import {
  type EnvironmentId,
  T3F_WS_METHODS,
  type T3fThreadBadge,
  type T3fThreadBadgeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type ThreadBadgeState =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly revision: number;
      readonly badges: ReadonlyMap<ThreadId, T3fThreadBadge>;
    };

const BEFORE_SNAPSHOT: ThreadBadgeState = { supported: true, revision: -1, badges: new Map() };
const UNSUPPORTED: ThreadBadgeState = { supported: false };

/** A snapshot replaces everything; a change applies only above the last revision seen. */
function applyThreadBadgeEvent(
  state: ThreadBadgeState,
  event: T3fThreadBadgeEvent,
): ThreadBadgeState {
  if (event.type === "snapshot") {
    return {
      supported: true,
      revision: event.revision,
      badges: new Map(
        event.badges.map(({ threadId, symbol, label }) => [threadId, { symbol, label }]),
      ),
    };
  }
  if (!state.supported || event.revision <= state.revision) return state;
  const badges = new Map(state.badges);
  if (event.badge === null) badges.delete(event.threadId);
  else badges.set(event.threadId, event.badge);
  return { supported: true, revision: event.revision, badges };
}

/** A server without badges answers the subscription with this defect; its clients show none. */
const isUnknownMethod = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      reason._tag === "Die" &&
      reason.defect === `Unknown request tag: ${T3F_WS_METHODS.threadBadgesSubscribe}`,
  );

export const followThreadBadges = <E, R>(events: Stream.Stream<T3fThreadBadgeEvent, E, R>) =>
  events.pipe(
    Stream.scan(() => BEFORE_SNAPSHOT, applyThreadBadgeEvent),
    // `scan` emits its seed first; skipping it keeps readers on "no badge" until the snapshot.
    Stream.filter((state) => state !== BEFORE_SNAPSHOT),
    Stream.catchCause((cause) =>
      isUnknownMethod(cause) ? Stream.make(UNSUPPORTED) : Stream.failCause(cause),
    ),
  );

export function createThreadBadgeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:t3f:thread-badges",
    tag: T3F_WS_METHODS.threadBadgesSubscribe,
    transform: followThreadBadges,
  });
  const current = Atom.family((environmentId: EnvironmentId) => {
    const result = state({ environmentId, input: {} });
    return Atom.make((get) => {
      const value = get(result);
      return AsyncResult.isSuccess(value) ? value.value : UNSUPPORTED;
    });
  });
  // One atom per thread, so a change re-renders only the row whose badge changed.
  const forThread = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) => {
      const snapshot = get(current(environmentId));
      return snapshot.supported ? (snapshot.badges.get(threadId) ?? null) : null;
    });
  });
  const supportedBy = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(current(environmentId));
      return snapshot.supported && snapshot.revision >= 0;
    }),
  );
  return {
    badgeOf: (environmentId: EnvironmentId, threadId: ThreadId) =>
      forThread(JSON.stringify([environmentId, threadId])),
    /** Whether this environment's server keeps badges, known once its snapshot has arrived. */
    supported: supportedBy,
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:t3f:thread-badges:set",
      tag: T3F_WS_METHODS.threadBadgesSet,
    }),
  };
}
