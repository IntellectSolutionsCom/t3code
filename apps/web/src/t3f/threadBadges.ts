import { createThreadBadgeAtoms } from "@t3tools/client-runtime/state/threadBadges";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export const threadBadges = createThreadBadgeAtoms(connectionAtomRuntime);

export function useThreadBadge(threadRef: ScopedThreadRef) {
  return useAtomValue(threadBadges.badgeOf(threadRef.environmentId, threadRef.threadId));
}

/** Which thread has Thread settings open. The thread menu and the command palette close as they run. */
export const threadSettingsThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-settings:thread"),
);

export function openThreadSettings(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadSettingsThreadAtom, threadRef);
}

const noEnvironment = Atom.make(false);

/** "Thread settings" is offered only where the server keeps badges; no environment means none. */
export const threadSettingsAvailable = Atom.family((environmentId: EnvironmentId | null) =>
  environmentId === null ? noEnvironment : threadBadges.supported(environmentId),
);

export function supportsThreadSettings(threadRef: ScopedThreadRef): boolean {
  return appAtomRegistry.get(threadSettingsAvailable(threadRef.environmentId));
}
