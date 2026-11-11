import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { decideWindowClose, readCloseDialogResult } from "./WindowClose.ts";

describe("decideWindowClose", () => {
  const lastWindow = { platform: "linux", quitting: false } as const;

  it.each([
    {
      name: "macOS keeps its close",
      input: { ...lastWindow, platform: "darwin", closeButton: "ask" },
      expected: "close",
    },
    {
      name: "macOS ignores keep running",
      input: { ...lastWindow, platform: "darwin", closeButton: "keepRunning" },
      expected: "close",
    },
    {
      name: "a quit in progress",
      input: { ...lastWindow, quitting: true, closeButton: "ask" },
      expected: "close",
    },
    {
      name: "a quit in progress with keep running",
      input: { ...lastWindow, platform: "win32", quitting: true, closeButton: "keepRunning" },
      expected: "close",
    },
    { name: "ask on Linux", input: { ...lastWindow, closeButton: "ask" }, expected: "ask" },
    {
      name: "ask on Windows",
      input: { ...lastWindow, platform: "win32", closeButton: "ask" },
      expected: "ask",
    },
    { name: "quit", input: { ...lastWindow, closeButton: "quit" }, expected: "close" },
    {
      name: "keep running",
      input: { ...lastWindow, closeButton: "keepRunning" },
      expected: "keepRunning",
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(decideWindowClose(input)).toBe(expected);
  });
});

describe("readCloseDialogResult", () => {
  it.each([
    { response: 0, checkboxChecked: false, answer: "cancel", remember: Option.none() },
    { response: 0, checkboxChecked: true, answer: "cancel", remember: Option.none() },
    { response: 1, checkboxChecked: false, answer: "keepRunning", remember: Option.none() },
    {
      response: 1,
      checkboxChecked: true,
      answer: "keepRunning",
      remember: Option.some("keepRunning"),
    },
    { response: 2, checkboxChecked: false, answer: "quit", remember: Option.none() },
    { response: 2, checkboxChecked: true, answer: "quit", remember: Option.some("quit") },
    { response: 7, checkboxChecked: true, answer: "cancel", remember: Option.none() },
  ] as const)(
    "button $response, remember $checkboxChecked",
    ({ response, checkboxChecked, answer, remember }) => {
      expect(readCloseDialogResult({ response, checkboxChecked })).toEqual({ answer, remember });
    },
  );
});
