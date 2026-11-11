import type { CloseButtonAction } from "@t3tools/contracts";
import { CLOSE_BUTTON_TEXT } from "@t3tools/shared/closeButtonText";
import * as Option from "effect/Option";
import type * as Electron from "electron";

export type WindowCloseDecision = "close" | "ask" | "keepRunning";
export type CloseDialogAnswer = "cancel" | "keepRunning" | "quit";

export function decideWindowClose(input: {
  readonly platform: NodeJS.Platform;
  readonly quitting: boolean;
  readonly closeButton: CloseButtonAction;
}): WindowCloseDecision {
  if (input.platform === "darwin" || input.quitting) return "close";
  return input.closeButton === "quit" ? "close" : input.closeButton;
}

// Button order matches CLOSE_DIALOG_ANSWERS; Cancel is first so it is the default and Escape.
const CLOSE_DIALOG_ANSWERS = [
  "cancel",
  "keepRunning",
  "quit",
] as const satisfies CloseDialogAnswer[];

export const CLOSE_DIALOG_OPTIONS: Electron.MessageBoxOptions = {
  type: "question",
  title: CLOSE_BUTTON_TEXT.dialog.title,
  message: CLOSE_BUTTON_TEXT.dialog.message,
  detail: CLOSE_BUTTON_TEXT.dialog.detail,
  checkboxLabel: CLOSE_BUTTON_TEXT.dialog.remember,
  checkboxChecked: false,
  buttons: [
    CLOSE_BUTTON_TEXT.dialog.cancel,
    CLOSE_BUTTON_TEXT.dialog.keepRunning,
    CLOSE_BUTTON_TEXT.dialog.quit,
  ],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
};

export function readCloseDialogResult(
  result: Pick<Electron.MessageBoxReturnValue, "response" | "checkboxChecked">,
): {
  readonly answer: CloseDialogAnswer;
  readonly remember: Option.Option<Exclude<CloseButtonAction, "ask">>;
} {
  const answer = CLOSE_DIALOG_ANSWERS[result.response] ?? "cancel";
  return {
    answer,
    remember: result.checkboxChecked && answer !== "cancel" ? Option.some(answer) : Option.none(),
  };
}
