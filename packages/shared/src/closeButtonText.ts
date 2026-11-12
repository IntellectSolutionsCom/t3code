import type { CloseButtonAction } from "@t3tools/contracts";
import { msg } from "gt-i18n";

/** Every word the close-button question and its setting show, so a wording change is one edit. */
export const CLOSE_BUTTON_TEXT = {
  setting: {
    title: msg("Close button", { $context: "window control" }),
    description: msg(
      "What the window's close button does on Linux and Windows. Ctrl+Q always quits while the window is open.",
    ),
    options: {
      ask: msg("Ask every time"),
      quit: msg("Quit T3 Code"),
      keepRunning: msg("Keep running in the background"),
    } satisfies Record<CloseButtonAction, string>,
  },
  dialog: {
    title: msg("Quit T3 Code?"),
    message: msg("Do you want to quit?"),
    detail: msg(
      "Quitting stops T3 Code and every running thread on this computer.\nKeep running closes the window; click the T3 Code icon in the system tray, or open T3 Code again, to bring it back.",
    ),
    remember: msg("Remember my decision"),
    cancel: msg("Cancel"),
    keepRunning: msg("Keep running"),
    quit: msg("Quit", { $context: "button, quits the app" }),
  },
} as const;
