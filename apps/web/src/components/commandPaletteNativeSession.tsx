import { useAtomValue } from "@effect/atom-react";
import { nativeSessionCommandAction } from "@t3tools/client-runtime/state/nativeSessions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { FingerprintIcon, HistoryIcon, LogInIcon, LogOutIcon, TerminalIcon } from "lucide-react";

import { namedClipboardTarget, writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { m, type MessageResolver } from "../i18n/messages";
import {
  nativeSessionEnvironment,
  useCanHandOut,
  useHandOutBlocker,
  useNativeSession,
  useTakeBack,
} from "../state/nativeSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { reportHandOutRefused } from "./chat/ThreadNativeSessionPanel";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { canLoadNativeSession, openLoadNativeSession } from "./LoadNativeSessionDialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

const copy = (value: string, kind: "id" | "command") =>
  writeTextToClipboard(value, namedClipboardTarget("native session")).then(
    () => {
      toastManager.add({
        type: "success",
        title: kind === "id" ? m(msg("Session id copied")) : m(msg("Command copied")),
      });
    },
    (error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            kind === "id"
              ? m(msg("Could not copy the session id"))
              : m(msg("Could not copy the command")),
          description: error instanceof Error ? error.message : m(msg("An error occurred.")),
        }),
      );
    },
  );

/** Palette actions for the active thread's own provider session. */
export function useNativeSessionPaletteItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const session = useNativeSession(ref);
  const takeBack = useTakeBack(ref);
  const supportsHandOut = useCanHandOut(ref?.environmentId ?? null);
  const mayHandOut = useAtomValue(
    nativeSessionEnvironment.handOut.permissionAtom(ref?.environmentId ?? null),
  );
  const handOut = useAtomCommand(
    nativeSessionEnvironment.handOut,
    gt("Could not move the session to the terminal"),
  );
  const handOutBlocker = useHandOutBlocker(ref);
  if (ref === null || session === null) return [];
  const { command } = session;
  const canHandOut = supportsHandOut && mayHandOut;
  const commandAction = nativeSessionCommandAction(canHandOut, takeBack !== null);
  const handOutItems: ReadonlyArray<CommandPaletteActionItem> = !canHandOut
    ? []
    : takeBack !== null
      ? [
          {
            kind: "action",
            value: "action:take-back-native-session",
            searchTerms: [
              "move",
              "take back",
              "session",
              "terminal",
              "native",
              "provider",
              "resume",
            ],
            title: gt("Move the session back"),
            description: gt("Unpauses this thread; send from here again"),
            icon: <LogInIcon className={ITEM_ICON_CLASS} />,
            run: async () => {
              await takeBack.takeBack();
            },
          },
        ]
      : command === null || handOutBlocker !== null
        ? []
        : [
            {
              kind: "action",
              value: "action:hand-out-native-session",
              searchTerms: ["move", "continue", "terminal", "hand out", "session", "native", "cli"],
              title: gt("Move the session to terminal"),
              description: gt("Pauses this thread here and copies the command"),
              icon: <LogOutIcon className={ITEM_ICON_CLASS} />,
              run: async () => {
                await copy(command, "command");
                reportHandOutRefused(
                  await handOut({
                    environmentId: ref.environmentId,
                    input: { threadId: ref.threadId },
                  }),
                );
              },
            },
          ];
  return [
    {
      kind: "action",
      value: "action:copy-native-session-id",
      searchTerms: ["copy", "session", "session id", "native", "provider", "resume"],
      title: gt("Copy session id"),
      description: session.nativeId,
      icon: <FingerprintIcon className={ITEM_ICON_CLASS} />,
      run: () => copy(session.nativeId, "id"),
    },
    ...(command === null || commandAction !== "copy"
      ? []
      : [
          {
            kind: "action" as const,
            value: "action:copy-native-session-command",
            searchTerms: ["copy", "session", "command", "terminal", "resume", "continue", "cli"],
            title: gt("Copy session command"),
            description: command,
            icon: <TerminalIcon className={ITEM_ICON_CLASS} />,
            run: () => copy(command, "command"),
          },
        ]),
    ...handOutItems,
  ];
}

/** Opens the project's provider sessions, to load one into a thread, where its server can. */
export const loadNativeSessionPaletteItems = (
  project: Parameters<typeof openLoadNativeSession>[0],
  resolve: MessageResolver,
): ReadonlyArray<CommandPaletteActionItem> =>
  canLoadNativeSession(project.environmentId)
    ? [
        {
          kind: "action",
          value: "action:load-native-session",
          searchTerms: [
            "load",
            "session",
            "import",
            "resume",
            "native",
            "provider",
            "cli",
            "claude",
            "codex",
          ],
          title: resolve(msg("Load a session into a thread…")),
          description: project.displayName,
          icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
          run: async () => openLoadNativeSession(project),
        },
      ]
    : [];
