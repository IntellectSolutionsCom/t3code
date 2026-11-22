import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  T3F_NATIVE_SESSION_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";

import {
  nativeSessionCommandAction,
  nativeSessionRow,
  orUnsupported,
  takeBackAndSend,
} from "./nativeSessions.ts";

const session = {
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  nativeId: "5a3356c8",
  name: "Fix the flaky test",
  cwd: "/home/user/app",
  command: "cd /home/user/app && claude --resume 5a3356c8",
  commandNote: null,
};

describe("the native session row", () => {
  it.effect("falls back to the thread's own record on a server that cannot identify", () =>
    Effect.gen(function* () {
      const identify = yield* orUnsupported(
        Effect.die(`Unknown request tag: ${T3F_NATIVE_SESSION_WS_METHODS.identify}`),
      );
      expect(nativeSessionRow({ fallbackNativeId: "5a3356c8", identify })).toEqual({
        nativeId: "5a3356c8",
        command: null,
        commandNote: null,
      });
      const other = yield* orUnsupported(Effect.die("Unknown request tag: other")).pipe(
        Effect.exit,
      );
      expect(other._tag).toBe("Failure");
    }),
  );

  it("carries the session id and command, and no name", () => {
    expect(
      nativeSessionRow({ fallbackNativeId: null, identify: { supported: true, session } }),
    ).toEqual({ nativeId: "5a3356c8", command: session.command, commandNote: null });
  });
});

describe("the native session command", () => {
  it.each([
    { canHandOut: true, isOut: false, action: "move" },
    { canHandOut: true, isOut: true, action: "copy" },
    { canHandOut: false, isOut: false, action: "copy" },
    { canHandOut: false, isOut: true, action: "copy" },
  ])(
    "offers $action when hand-out is $canHandOut and out is $isOut",
    ({ canHandOut, isOut, action }) => {
      expect(nativeSessionCommandAction(canHandOut, isOut)).toBe(action);
    },
  );
});

describe("take back and send", () => {
  it.each([
    {
      driver: "codex",
      confirmed: null,
      tookBack: true,
      movedAway: false,
      steps: ["take back", "send"],
    },
    {
      driver: "claudeAgent",
      confirmed: true,
      tookBack: true,
      movedAway: false,
      steps: ["confirm", "take back", "send"],
    },
    {
      driver: "claudeAgent",
      confirmed: false,
      tookBack: true,
      movedAway: false,
      steps: ["confirm"],
    },
    {
      driver: "codex",
      confirmed: null,
      tookBack: false,
      movedAway: false,
      steps: ["take back"],
    },
    // The view showed another thread by the time the take-back answered.
    {
      driver: "codex",
      confirmed: null,
      tookBack: true,
      movedAway: true,
      steps: ["take back"],
    },
  ])(
    "$driver, confirmed $confirmed, taken back $tookBack, moved away $movedAway: $steps",
    async ({ driver, confirmed, tookBack, movedAway, steps }) => {
      const done: Array<string> = [];
      let viewing = true;
      const sent = await takeBackAndSend({
        out: {
          threadId: ThreadId.make("thread-1"),
          driver: ProviderDriverKind.make(driver),
          since: "2026-03-17T19:12:28.000Z",
        },
        confirm: async () => {
          done.push("confirm");
          return confirmed === true;
        },
        takeBack: async () => {
          done.push("take back");
          if (movedAway) viewing = false;
          return tookBack ? AsyncResult.success({}) : AsyncResult.failure(Cause.fail("refused"));
        },
        send: async () => {
          done.push("send");
          return "message-1";
        },
        stillCurrent: () => viewing,
      });
      expect(done).toEqual(steps);
      expect(sent).toBe(steps.includes("send") ? "message-1" : undefined);
    },
  );
});
