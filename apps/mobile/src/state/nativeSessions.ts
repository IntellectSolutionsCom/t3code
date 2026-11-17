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
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useContext } from "react";
import { Alert } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";
import { useQuietThreadStructure } from "./use-thread-detail";

export const nativeSessionEnvironment = createNativeSessionAtoms(connectionAtomRuntime);

/** The identify query for the thread's current session, without reading it. */
function useIdentifyAtom(ref: ScopedThreadRef | null) {
  const projection = useQuietThreadStructure(ref)?.projection ?? null;
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
  return handOutBlocker(useQuietThreadStructure(ref)?.projection ?? null);
}

/** Older servers have no hand-out requests, so nothing about it shows for them. */
export function useCanHandOut(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
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

const confirmTakeBack = (confirmation: TakeBackConfirmation) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      confirmation.title,
      confirmation.description,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: confirmation.confirmLabel, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

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
    // A refresh, not a read: only a mounted row fetches again.
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
export function useSendTakingBack<Args extends ReadonlyArray<unknown>, A>(
  ref: ScopedThreadRef | null,
  send: (...args: Args) => Promise<A | null>,
) {
  const takeBack = useTakeBack(ref);
  if (takeBack === null) return send;
  return async (...args: Args) => (await takeBack.takeBackAndSend(() => send(...args))) ?? null;
}
