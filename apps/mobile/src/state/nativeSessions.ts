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
import { msg, useGT } from "gt-react-native";
import { Alert } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { m } from "../i18n/messages";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";
import { useQuietThreadStructure } from "./use-thread-detail";

export const nativeSessionEnvironment = createNativeSessionAtoms(connectionAtomRuntime);

/** The thread's own provider session, or null before its provider opens one. */
export function useNativeSession(ref: ScopedThreadRef | null) {
  const projection = useQuietThreadStructure(ref)?.projection ?? null;
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
        { text: m(msg("Cancel")), style: "cancel", onPress: () => resolve(false) },
        { text: confirmation.confirmLabel, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

/** Take-back for the thread, or null while it is not out. */
export function useTakeBack(ref: ScopedThreadRef | null) {
  const out = useNativeSessionOut(ref);
  const gt = useGT();
  const takeBack = useAtomCommand(
    nativeSessionEnvironment.takeBack,
    gt("Could not move the session back"),
  );
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
    takeBackAndSend: <A>(send: () => Promise<A>) => takeBackAndSend({ ...input, send }, m),
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
