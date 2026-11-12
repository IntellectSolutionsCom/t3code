import type { CloseButtonAction } from "@t3tools/contracts";
import { CLOSE_BUTTON_TEXT } from "@t3tools/shared/closeButtonText";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import { m } from "../i18n/messages.ts";

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

export function closeDialogOptions(): Electron.MessageBoxOptions {
  return {
    type: "question",
    title: m(CLOSE_BUTTON_TEXT.dialog.title),
    message: m(CLOSE_BUTTON_TEXT.dialog.message),
    detail: m(CLOSE_BUTTON_TEXT.dialog.detail),
    checkboxLabel: m(CLOSE_BUTTON_TEXT.dialog.remember),
    checkboxChecked: false,
    buttons: [
      m(CLOSE_BUTTON_TEXT.dialog.cancel),
      m(CLOSE_BUTTON_TEXT.dialog.keepRunning),
      m(CLOSE_BUTTON_TEXT.dialog.quit),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

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
