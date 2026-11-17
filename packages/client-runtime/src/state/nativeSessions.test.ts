import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  T3F_NATIVE_SESSION_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { nativeSessionRow, orUnsupported } from "./nativeSessions.ts";

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
