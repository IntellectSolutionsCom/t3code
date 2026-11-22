import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  handOutRefusedDescription,
  nativeSessionCommandAction,
} from "@t3tools/client-runtime/state/nativeSessions";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, msg, useGT } from "gt-react";
import { CopyIcon, LogOutIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { m } from "../../i18n/messages";
import {
  nativeSessionEnvironment,
  useCanHandOut,
  useHandOutBlocker,
  useNativeSession,
  useTakeBack,
} from "../../state/nativeSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
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
      title: m(msg("Not moved to the terminal")),
      description: handOutRefusedDescription(
        error instanceof Error ? error.message : String(error),
        m,
      ),
    }),
  );
};

/** The provider's own session behind the thread. Hidden until the provider opens one. */
export function ThreadNativeSessionPanel(props: ThreadNativeSessionPanelProps) {
  const gt = useGT();
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
    gt("Could not move the session to the terminal"),
  );
  const environment = useEnvironment(props.environmentId)?.label ?? null;
  // The command runs on the machine that holds the session, which may not be this one.
  const commandHint = (command: string) =>
    environment === null
      ? command
      : gt("Run on {environment}:\n{command}", { environment, command });
  const { copyToClipboard } = useCopyToClipboard<"id" | "command">({
    target: namedClipboardTarget("native session"),
    onCopy: (kind) =>
      toastManager.add({
        type: "success",
        title: kind === "id" ? m(msg("Session id copied")) : m(msg("Command copied")),
      }),
    onError: (error, kind) =>
      reportFailure(
        kind === "id"
          ? m(msg("Could not copy the session id"))
          : m(msg("Could not copy the command")),
        error,
      ),
  });
  if (session === null) return null;
  const { nativeId, command, commandNote } = session;

  // Copied before the request, while the click still counts as the person's gesture.
  const moveToTerminal = (command: string) => {
    copyToClipboard(command, "command");
    void handOut({ environmentId: props.environmentId, input: { threadId: props.threadId } }).then(
      reportHandOutRefused,
    );
  };

  const commandAction = nativeSessionCommandAction(canHandOut, takeBack !== null);
  return (
    <ThreadDetailsSection
      headingId="thread-details-native-session-heading"
      title={gt("Native session")}
    >
      <ul className="m-0 list-none p-0">
        <SessionRow
          icon={<CopyIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
          value={gt("Copy session id")}
          tooltip={gt("Copy session id")}
          onClick={() => copyToClipboard(nativeId, "id")}
        />
        {takeBack !== null ? (
          <li className="flex flex-col gap-1 px-2.5 py-1.5">
            <span className="flex items-center gap-2 text-xs text-foreground/85">
              <TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <T>In terminal · paused here</T>
            </span>
            <div className="flex flex-wrap items-center gap-1 ps-6">
              {command !== null ? (
                <Tooltip>
                  <TooltipTrigger
                    delay={200}
                    render={
                      <ThreadDetailsControl
                        variant="ghost"
                        part="meta"
                        onClick={() => copyToClipboard(command, "command")}
                      />
                    }
                  >
                    <T>Copy command</T>
                  </TooltipTrigger>
                  <TooltipPopup side="left">{commandHint(command)}</TooltipPopup>
                </Tooltip>
              ) : null}
              {mayHandOut ? (
                <ThreadDetailsControl
                  variant="ghost"
                  part="meta"
                  onClick={() => void takeBack.takeBack()}
                >
                  <T>Move back</T>
                </ThreadDetailsControl>
              ) : null}
            </div>
          </li>
        ) : command === null ? null : commandAction === "copy" ? (
          <SessionRow
            icon={<TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
            value={gt("Copy command")}
            tooltip={commandHint(command)}
            onClick={() => copyToClipboard(command, "command")}
          />
        ) : (
          <SessionRow
            icon={<LogOutIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
            value={gt("Move to terminal")}
            blockedBy={handOutBlocker}
            tooltip={
              environment === null
                ? gt("Pauses this thread here and copies the command:\n{command}", { command })
                : gt(
                    "Pauses this thread here and copies the command to run on {environment}:\n{command}",
                    { environment, command },
                  )
            }
            onClick={() => moveToTerminal(command)}
          />
        )}
        {command === null && commandNote !== null ? (
          <li className="px-2.5 py-1 text-2xs leading-4 text-muted-foreground">{commandNote}</li>
        ) : null}
      </ul>
    </ThreadDetailsSection>
  );
}

function SessionRow(props: {
  readonly icon: ReactNode;
  readonly value: string;
  readonly tooltip: string;
  readonly onClick: () => void;
  readonly blockedBy?: string | null;
}) {
  const blocked = props.blockedBy != null;
  return (
    <li className="flex items-center rounded-lg">
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                multiline
                aria-disabled={blocked || undefined}
                onClick={blocked ? undefined : props.onClick}
              />
            }
          >
            {props.icon}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-xs leading-4">{props.value}</span>
              {blocked ? (
                <span className="whitespace-normal text-2xs font-normal leading-4 text-muted-foreground">
                  {props.blockedBy}
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left" className="whitespace-pre-wrap">
            {props.tooltip}
          </TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}
