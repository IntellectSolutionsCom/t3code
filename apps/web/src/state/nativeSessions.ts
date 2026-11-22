import { useAtomValue } from "@effect/atom-react";
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
import { useGT } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useStableCallback } from "../hooks/useStableCallback";
import { m } from "../i18n/messages";
import { readLocalApi } from "../localApi";
import { useQuietThreadProjection } from "./entities";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const nativeSessionEnvironment = createNativeSessionAtoms(connectionAtomRuntime);

/** The thread's own provider session, or null before its provider opens one. */
export function useNativeSession(ref: ScopedThreadRef | null) {
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const fallbackNativeId =
    projection === null
      ? null
      : activeNativeId(projection.thread.activeProviderThreadId, projection.providerThreads);
  const identify = useEnvironmentQuery(
    ref === null || fallbackNativeId === null
      ? null
      : nativeSessionEnvironment.identify({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, nativeId: fallbackNativeId },
        }),
  );
  return nativeSessionRow({ fallbackNativeId, identify: identify.data });
}

/** Why "Move to terminal" is unavailable for the thread now, or null. */
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
  const gt = useGT();
  const takeBack = useAtomCommand(
    nativeSessionEnvironment.takeBack,
    gt("Could not move the session back"),
  );
  const viewedThread = ref === null ? null : `${ref.environmentId}:${ref.threadId}`;
  // One chat view serves every thread, so a send that waited on the take-back checks it still shows this one.
  const stillViewing = useStableCallback((thread: string) => thread === viewedThread);
  if (ref === null || out === null) return null;
  const input: TakeBackInput = {
    out,
    confirm: confirmTakeBack,
    takeBack: () =>
      takeBack({ environmentId: ref.environmentId, input: { threadId: ref.threadId } }),
  };
  return {
    out,
    takeBack: () => takeBackThread(input, m),
    takeBackAndSend: <A>(send: () => Promise<A>) =>
      takeBackAndSend(
        {
          ...input,
          send,
          stillCurrent: () => stillViewing(`${ref.environmentId}:${ref.threadId}`),
        },
        m,
      ),
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
