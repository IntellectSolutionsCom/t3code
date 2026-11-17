import {
  activeNativeId,
  createNativeSessionAtoms,
  nativeSessionRow,
} from "@t3tools/client-runtime/state/nativeSessions";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useQuietThreadStructure } from "./use-thread-detail";

const nativeSessionEnvironment = createNativeSessionAtoms(connectionAtomRuntime);

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
  return nativeSessionRow({
    title: projection?.thread.title ?? "",
    fallbackNativeId,
    identify: identify.data,
  });
}
