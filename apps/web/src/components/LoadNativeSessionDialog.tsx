import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ProjectId,
  type T3fNativeSessionListItem,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { brandProviderInstanceEntries, deriveProviderInstanceEntries } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { nativeSessionEnvironment } from "~/state/nativeSessions";
import { environmentPresentations } from "~/state/presentation";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

/** A project as the sidebar and the command palette hold it. */
interface LoadNativeSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly displayName: string;
}

const requestAtom = Atom.make<LoadNativeSessionTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("native-sessions:load"),
);

export const canLoadNativeSession = (environmentId: EnvironmentId): boolean =>
  appAtomRegistry.get(environmentPresentations.serverConfigsAtom).get(environmentId)?.environment
    .capabilities.nativeSessionLoading === true;

export function openLoadNativeSession(project: LoadNativeSessionTarget): void {
  appAtomRegistry.set(requestAtom, {
    environmentId: project.environmentId,
    id: project.id,
    displayName: project.displayName,
  });
}

const close = () => appAtomRegistry.set(requestAtom, null);

/** Hosted once at the root, so the sidebar and Cmd-K can open it from anywhere. */
export function LoadNativeSessionDialogHost() {
  const target = useAtomValue(requestAtom);
  return target === null ? null : (
    <LoadNativeSessionDialog key={`${target.environmentId}:${target.id}`} target={target} />
  );
}

const sessionKey = (session: T3fNativeSessionListItem) =>
  `${session.providerInstanceId}\0${session.nativeId}`;

function LoadNativeSessionDialog({ target }: { readonly target: LoadNativeSessionTarget }) {
  const gt = useGT();
  const navigate = useNavigate();
  const list = useEnvironmentQuery(
    nativeSessionEnvironment.list({
      environmentId: target.environmentId,
      input: { projectId: target.id },
    }),
  );
  const canAdopt = useAtomValue(
    nativeSessionEnvironment.adopt.permissionAtom(target.environmentId),
  );
  const adopt = useAtomCommand(nativeSessionEnvironment.adopt, "Could not load the session");
  const [loading, setLoading] = useState<string | null>(null);

  const openThread = (threadId: ThreadId | null) => {
    if (threadId === null) return;
    close();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, threadId)),
    });
  };

  const load = async (session: T3fNativeSessionListItem) => {
    if (loading !== null) return;
    setLoading(sessionKey(session));
    const result = await adopt({
      environmentId: target.environmentId,
      input: {
        projectId: target.id,
        providerInstanceId: session.providerInstanceId,
        nativeId: session.nativeId,
      },
    });
    setLoading(null);
    if (result._tag === "Success") openThread(result.value.threadId);
  };

  const config = useAtomValue(environmentPresentations.serverConfigsAtom).get(target.environmentId);
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
    target.environmentId,
  );
  const entries = deriveProviderInstanceEntries(providers ?? []);
  const instances =
    config === undefined ? entries : brandProviderInstanceEntries(entries, config.settings);
  const providerLabel = (session: Pick<T3fNativeSessionListItem, "providerInstanceId">) =>
    instances.find((entry) => entry.instanceId === session.providerInstanceId)?.displayName ??
    session.providerInstanceId;

  const sessions = list.data?.sessions ?? null;
  const unlisted = list.data?.unlisted ?? [];
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Load a session into a thread</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Provider sessions that ran in <Var>{target.displayName}</Var> in the last 30 days,
              including ones started outside <Var>{"T3 Code"}</Var>.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {list.error !== null ? (
            <p className="text-sm text-destructive-foreground">{list.error}</p>
          ) : sessions === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> <T>Reading sessions…</T>
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No provider sessions ran in this folder in the last 30 days.</T>
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {sessions.map((session) => (
                <li key={sessionKey(session)} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">
                      {session.name ?? gt("Untitled session")}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {providerLabel(session)}
                      {session.updatedAt === null
                        ? ""
                        : ` · ${formatRelativeTimeLabel(session.updatedAt)}`}
                    </p>
                  </div>
                  {session.threadId !== null ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openThread(session.threadId)}
                    >
                      <T context="verb, navigate to the thread">Open thread</T>
                    </Button>
                  ) : session.threadDeleted ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <T>Its thread was deleted</T>
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canAdopt || loading !== null}
                      onClick={() => void load(session)}
                    >
                      {loading === sessionKey(session) ? (
                        <T>Loading…</T>
                      ) : (
                        <T context="verb, load a provider session into a thread">Load</T>
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unlisted.length > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              <T>
                Could not list the sessions of{" "}
                <Var>
                  {unlisted
                    .map((agent) => {
                      const provider = providerLabel(agent);
                      return agent.reason === "timed_out"
                        ? gt("{provider} (no answer in time)", { provider })
                        : gt("{provider} (failed)", { provider });
                    })
                    .join(", ")}
                </Var>
                .
              </T>
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
