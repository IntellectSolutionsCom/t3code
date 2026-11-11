import type { CloseButtonAction } from "@t3tools/contracts";

/** Every word the close-button question and its setting show, so a wording change is one edit. */
export const CLOSE_BUTTON_TEXT = {
  setting: {
    title: "Close button",
    description:
      "What the window's close button does on Linux and Windows. Ctrl+Q always quits while the window is open.",
    options: {
      ask: "Ask every time",
      quit: "Quit T3 Code",
      keepRunning: "Keep running in the background",
    } satisfies Record<CloseButtonAction, string>,
  },
  dialog: {
    title: "Quit T3 Code?",
    message: "Do you want to quit?",
    detail:
      "Quitting stops T3 Code and every running thread on this computer.\n" +
      "Keep running closes the window; open T3 Code again to bring it back.",
    remember: "Remember my decision",
    cancel: "Cancel",
    keepRunning: "Keep running",
    quit: "Quit",
  },
} as const;
