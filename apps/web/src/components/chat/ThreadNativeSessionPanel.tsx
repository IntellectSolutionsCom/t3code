import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { handOutRefusedDescription } from "@t3tools/client-runtime/state/nativeSessions";
import {
  type AtomCommandResult,
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
import {
  nativeSessionEnvironment,
  useCanHandOut,
  useHandOutBlocker,
  useNativeSession,
  useTakeBack,
} from "../../state/nativeSessions";
import { useAtomCommand } from "../../state/use-atom-command";
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

/** Warns that the command already copied must not run while T3 Code still holds the session. */
export const reportHandOutRefused = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Not handed out",
      description: handOutRefusedDescription(
        error instanceof Error ? error.message : String(error),
      ),
    }),
  );
};

/** The provider's own session behind the thread. Hidden until the provider opens one. */
export function ThreadNativeSessionPanel(props: ThreadNativeSessionPanelProps) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const session = useNativeSession(ref);
  const takeBack = useTakeBack(ref);
  const supportsHandOut = useCanHandOut(props.environmentId);
  const mayHandOut = useAtomValue(
    nativeSessionEnvironment.handOut.permissionAtom(props.environmentId),
  );
  const canHandOut = supportsHandOut && mayHandOut;
  const handOutBlocker = useHandOutBlocker(ref);
  const handOut = useAtomCommand(
    nativeSessionEnvironment.handOut,
    "Could not hand the session out",
  );
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

  // Copied before the request, while the click still counts as the person's gesture.
  const continueInTerminal = (command: string) => {
    copyToClipboard(command, { what: "Command" });
    void handOut({ environmentId: props.environmentId, input: { threadId: props.threadId } }).then(
      reportHandOutRefused,
    );
  };

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
            long
            caption={environmentLabel === null ? "Command" : `Command · run on ${environmentLabel}`}
            tooltip="Copy the command that continues this session in the provider's own client"
            onClick={() =>
              session.command !== null && copyToClipboard(session.command, { what: "Command" })
            }
            action={
              !canHandOut
                ? undefined
                : takeBack !== null
                  ? { label: "Take back", onClick: () => void takeBack.takeBack() }
                  : {
                      label: "Continue in terminal",
                      onClick: () =>
                        session.command !== null && continueInTerminal(session.command),
                      blockedBy: handOutBlocker,
                    }
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
  /** Wraps the value and puts the action on its own line, so neither hides the other. */
  readonly long?: boolean;
  readonly caption: string;
  readonly tooltip: string;
  readonly onClick: () => void;
  readonly action?:
    | {
        readonly label: string;
        readonly onClick: () => void;
        /** Disables the action and says why. */
        readonly blockedBy?: string | null;
      }
    | undefined;
}) {
  const blockedBy = props.action?.blockedBy ?? null;
  const action = props.action ? (
    <ThreadDetailsControl
      variant="ghost"
      part="meta"
      disabled={blockedBy !== null}
      onClick={props.action.onClick}
    >
      {props.action.label}
    </ThreadDetailsControl>
  ) : null;
  return (
    <li className="relative flex flex-col rounded-lg">
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
          <span
            className={cn("flex min-w-0 flex-1 flex-col gap-0.5", action && !props.long && "pe-24")}
          >
            <span
              className={cn(
                "font-mono text-xs leading-4 text-foreground/85",
                props.long ? "whitespace-normal [overflow-wrap:anywhere]" : "truncate",
              )}
            >
              {props.value}
            </span>
            <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
              {props.caption}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">{props.tooltip}</TooltipPopup>
      </Tooltip>
      {action === null ? null : props.long ? (
        <div className="flex items-center gap-2 ps-8 pb-1">
          {action}
          {blockedBy === null ? null : (
            <span className="text-2xs leading-4 text-muted-foreground">{blockedBy}</span>
          )}
        </div>
      ) : (
        <div className="absolute right-1 top-1/2 -translate-y-1/2">{action}</div>
      )}
    </li>
  );
}
