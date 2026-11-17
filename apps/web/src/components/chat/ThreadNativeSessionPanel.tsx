import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { FingerprintIcon, TagIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { useNativeSession } from "../../state/nativeSessions";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

interface ThreadNativeSessionPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** The provider's own session behind the thread. Hidden until the provider opens one. */
export function ThreadNativeSessionPanel(props: ThreadNativeSessionPanelProps) {
  const session = useNativeSession(scopeThreadRef(props.environmentId, props.threadId));
  const environmentLabel = useEnvironment(props.environmentId)?.label ?? null;
  const canRename = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{ readonly what: string }>({
    target: namedClipboardTarget("native session"),
    onCopy: ({ what }) => toastManager.add({ type: "success", title: `${what} copied` }),
    onError: (error, { what }) => reportFailure(`Could not copy the ${what.toLowerCase()}`, error),
  });
  if (session === null) return null;

  const renameThread = (title: string) =>
    void updateMetadata({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Failed to rename thread", squashAtomCommandFailure(result));
      }
    });

  return (
    <ThreadDetailsSection headingId="thread-details-native-session-heading" title="Native session">
      <ul className="m-0 list-none p-0">
        <SessionRow
          icon={<FingerprintIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
          value={session.nativeId}
          caption="Session id"
          tooltip="Copy session id"
          onClick={() => copyToClipboard(session.nativeId, { what: "Session id" })}
        />
        {session.name !== null ? (
          <SessionRow
            icon={<TagIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
            value={session.name}
            caption="Session name"
            tooltip="Copy name"
            onClick={() => session.name !== null && copyToClipboard(session.name, { what: "Name" })}
            action={
              canRename
                ? {
                    label: "Use as title",
                    onClick: () => session.name !== null && renameThread(session.name),
                  }
                : undefined
            }
          />
        ) : null}
        {session.command !== null ? (
          <SessionRow
            icon={<TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
            value={session.command}
            caption={environmentLabel === null ? "Command" : `Command · run on ${environmentLabel}`}
            tooltip="Copy the command that continues this session in the provider's own client"
            onClick={() =>
              session.command !== null && copyToClipboard(session.command, { what: "Command" })
            }
          />
        ) : session.commandNote !== null ? (
          <li className="px-2.5 py-1 text-2xs leading-4 text-muted-foreground">
            {session.commandNote}
          </li>
        ) : null}
      </ul>
    </ThreadDetailsSection>
  );
}

function SessionRow(props: {
  readonly icon: ReactNode;
  readonly value: string;
  readonly caption: string;
  readonly tooltip: string;
  readonly onClick: () => void;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <li className="relative flex items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              multiline
              onClick={props.onClick}
            />
          }
        >
          {props.icon}
          {/* The end padding keeps text clear of the action. */}
          <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", props.action && "pe-24")}>
            <span className="truncate font-mono text-xs leading-4 text-foreground/85">
              {props.value}
            </span>
            <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
              {props.caption}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">{props.tooltip}</TooltipPopup>
      </Tooltip>
      {props.action ? (
        <div className="absolute right-1 top-1/2 -translate-y-1/2">
          <ThreadDetailsControl variant="ghost" part="meta" onClick={props.action.onClick}>
            {props.action.label}
          </ThreadDetailsControl>
        </div>
      ) : null}
    </li>
  );
}
