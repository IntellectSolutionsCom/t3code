import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SettingsIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { openThreadSettings, threadSettingsAvailable } from "./threadBadges";

/** The palette's "Thread settings" action for the active thread, offered where the server keeps badges. */
export function useThreadSettingsActions(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): CommandPaletteActionItem[] {
  const available = useAtomValue(threadSettingsAvailable(thread?.environmentId ?? null));
  if (thread === null || !available) return [];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return [
    {
      kind: "action",
      value: "action:thread-settings",
      searchTerms: ["thread", "settings", "badge", "emoji", "label"],
      title: "Thread settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openThreadSettings(threadRef);
      },
    },
  ];
}
