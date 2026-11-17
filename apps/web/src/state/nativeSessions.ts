import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  activeNativeId,
  createNativeSessionAtoms,
  handOutBlocker,
  nativeSessionRow,
  outThread,
  takeBackAndSend,
  takeBackThread,
  type TakeBackConfirmation,
  type TakeBackInput,
} from "@t3tools/client-runtime/state/nativeSessions";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { readLocalApi } from "../localApi";
import { useQuietThreadProjection } from "./entities";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const nativeSessionEnvironment = createNativeSessionAtoms(connectionAtomRuntime);

/** The identify query for the thread's current session, without reading it. */
function useIdentifyAtom(ref: ScopedThreadRef | null) {
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const fallbackNativeId =
    projection === null
      ? null
      : activeNativeId(projection.thread.activeProviderThreadId, projection.providerThreads);
  const atom =
    ref === null || fallbackNativeId === null
      ? null
      : nativeSessionEnvironment.identify({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, nativeId: fallbackNativeId },
        });
  return { title: projection?.thread.title ?? "", fallbackNativeId, atom };
}

/** The thread's own provider session, or null before its provider opens one. */
export function useNativeSession(ref: ScopedThreadRef | null) {
  const { title, fallbackNativeId, atom } = useIdentifyAtom(ref);
  const identify = useEnvironmentQuery(atom);
  return nativeSessionRow({ title, fallbackNativeId, identify: identify.data });
}

/** Why "Continue in terminal" is unavailable for the thread now, or null. */
export function useHandOutBlocker(ref: ScopedThreadRef | null): string | null {
  return handOutBlocker(useQuietThreadProjection(ref)?.projection ?? null);
}

/** Older servers have no hand-out requests, so nothing about it shows for them. */
export function useCanHandOut(environmentId: EnvironmentId | null): boolean {
  const configs = useAtomValue(environmentPresentations.serverConfigsAtom);
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.nativeSessionHandout === true
  );
}

/** Whether the thread is out in its provider's own client, and since when. */
export function useNativeSessionOut(ref: ScopedThreadRef | null) {
  const supported = useCanHandOut(ref?.environmentId ?? null);
  const out = useEnvironmentQuery(
    ref === null || !supported
      ? null
      : nativeSessionEnvironment.out({ environmentId: ref.environmentId, input: {} }),
  );
  return ref === null ? null : outThread(out.data?.threads, ref.threadId);
}

const confirmTakeBack = async (confirmation: TakeBackConfirmation) =>
  (await readLocalApi()?.dialogs.confirm(`${confirmation.title}\n${confirmation.description}`)) ??
  false;

/** Take-back for the thread, or null while it is not out. */
export function useTakeBack(ref: ScopedThreadRef | null) {
  const out = useNativeSessionOut(ref);
  const takeBack = useAtomCommand(
    nativeSessionEnvironment.takeBack,
    "Could not take the session back",
  );
  const registry = useContext(RegistryContext);
  const identify = useIdentifyAtom(ref).atom;
  if (ref === null || out === null) return null;
  const input: TakeBackInput = {
    out,
    confirm: confirmTakeBack,
    takeBack: () =>
      takeBack({ environmentId: ref.environmentId, input: { threadId: ref.threadId } }),
    // A refresh, not a read: only a mounted row or label fetches again.
    refreshSession: () => {
      if (identify !== null) registry.refresh(identify);
    },
  };
  return {
    out,
    takeBack: () => takeBackThread(input),
    takeBackAndSend: <A>(send: () => Promise<A>) => takeBackAndSend({ ...input, send }),
  };
}

/** The composer's send, taking the thread back first while it is out. */
export function useSendTakingBack<Rest extends ReadonlyArray<unknown>>(
  ref: ScopedThreadRef | null,
  send: (event?: { preventDefault: () => void }, ...rest: Rest) => Promise<void>,
) {
  const takeBack = useTakeBack(ref);
  if (takeBack === null) return send;
  return async (event?: { preventDefault: () => void }, ...rest: Rest) => {
    event?.preventDefault();
    await takeBack.takeBackAndSend(() => send(event, ...rest));
  };
}
