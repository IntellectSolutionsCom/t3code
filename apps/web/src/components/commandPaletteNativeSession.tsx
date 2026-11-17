import type { ScopedThreadRef } from "@t3tools/contracts";
import { FingerprintIcon, HistoryIcon, TerminalIcon } from "lucide-react";

import { namedClipboardTarget, writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useNativeSession } from "../state/nativeSessions";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { canLoadNativeSession, openLoadNativeSession } from "./LoadNativeSessionDialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

const copy = (value: string, what: string) =>
  writeTextToClipboard(value, namedClipboardTarget("native session")).then(
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
  if (session === null) return [];
  const { command } = session;
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
