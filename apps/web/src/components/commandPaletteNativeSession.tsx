import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { FingerprintIcon, HistoryIcon, LogInIcon, LogOutIcon, TerminalIcon } from "lucide-react";

import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
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

const copy = (value: string, what: string) =>
  writeTextToClipboard(value, "native session").then(
    () => {
      toastManager.add({ type: "success", title: `${what} copied` });
    },
    (error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy the ${what.toLowerCase()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  );

/** Palette actions for the active thread's own provider session. */
export function useNativeSessionPaletteItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const session = useNativeSession(ref);
  const takeBack = useTakeBack(ref);
  const supportsHandOut = useCanHandOut(ref?.environmentId ?? null);
  const mayHandOut = useAtomValue(
    nativeSessionEnvironment.handOut.permissionAtom(ref?.environmentId ?? null),
  );
  const handOut = useAtomCommand(
    nativeSessionEnvironment.handOut,
    "Could not hand the session out",
  );
  const handOutBlocker = useHandOutBlocker(ref);
  if (ref === null || session === null) return [];
  const { command } = session;
  const handOutItems: ReadonlyArray<CommandPaletteActionItem> =
    !supportsHandOut || !mayHandOut
      ? []
      : takeBack !== null
        ? [
            {
              kind: "action",
              value: "action:take-back-native-session",
              searchTerms: ["take back", "session", "terminal", "native", "provider", "resume"],
              title: "Take the session back",
              description: "Send from T3 Code again",
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
                searchTerms: ["continue", "terminal", "hand out", "session", "native", "cli"],
                title: "Continue in terminal",
                description: "Copies the command and hands the session to its own client",
                icon: <LogOutIcon className={ITEM_ICON_CLASS} />,
                run: async () => {
                  await copy(command, "Command");
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
      title: "Copy session id",
      description: session.nativeId,
      icon: <FingerprintIcon className={ITEM_ICON_CLASS} />,
      run: () => copy(session.nativeId, "Session id"),
    },
    ...(command === null
      ? []
      : [
          {
            kind: "action" as const,
            value: "action:copy-native-session-command",
            searchTerms: ["copy", "session", "command", "terminal", "resume", "continue", "cli"],
            title: "Copy session command",
            description: command,
            icon: <TerminalIcon className={ITEM_ICON_CLASS} />,
            run: () => copy(command, "Command"),
          },
        ]),
    ...handOutItems,
  ];
}

/** Opens the project's provider sessions, to load one into a thread, where its server can. */
export const loadNativeSessionPaletteItems = (
  project: Parameters<typeof openLoadNativeSession>[0],
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
          title: "Load a session into a thread…",
          description: project.displayName,
          icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
          run: async () => openLoadNativeSession(project),
        },
      ]
    : [];
