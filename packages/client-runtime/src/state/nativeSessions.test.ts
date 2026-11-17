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

import { nativeSessionRow, orUnsupported, takeBackAndSend } from "./nativeSessions.ts";

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
      expect(nativeSessionRow({ title: "T", fallbackNativeId: "5a3356c8", identify })).toEqual({
        nativeId: "5a3356c8",
        name: null,
        command: null,
        commandNote: null,
      });
      const other = yield* orUnsupported(Effect.die("Unknown request tag: other")).pipe(
        Effect.exit,
      );
      expect(other._tag).toBe("Failure");
    }),
  );

  it.each([
    { title: "Fix the flaky test", name: null },
    { title: "Something else", name: "Fix the flaky test" },
  ])("shows the session's name only when it differs from $title", ({ title, name }) => {
    expect(
      nativeSessionRow({
        title,
        fallbackNativeId: null,
        identify: { supported: true, session },
      })?.name,
    ).toBe(name);
  });
});

describe("take back and send", () => {
  it.each([
    {
      driver: "codex",
      confirmed: null,
      tookBack: true,
      steps: ["take back", "refresh session", "send"],
    },
    {
      driver: "claudeAgent",
      confirmed: true,
      tookBack: true,
      steps: ["confirm", "take back", "refresh session", "send"],
    },
    { driver: "claudeAgent", confirmed: false, tookBack: true, steps: ["confirm"] },
    { driver: "codex", confirmed: null, tookBack: false, steps: ["take back"] },
  ])(
    "$driver, confirmed $confirmed, taken back $tookBack: $steps",
    async ({ driver, confirmed, tookBack, steps }) => {
      const done: Array<string> = [];
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
          return tookBack ? AsyncResult.success({}) : AsyncResult.failure(Cause.fail("refused"));
        },
        refreshSession: () => {
          done.push("refresh session");
        },
        send: async () => {
          done.push("send");
          return "message-1";
        },
      });
      expect(done).toEqual(steps);
      expect(sent).toBe(steps.includes("send") ? "message-1" : undefined);
    },
  );
});
