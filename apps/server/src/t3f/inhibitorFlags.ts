import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// From v257 systemd-inhibit asks polkit for a password by default, and only v257+ knows the flag.
const NO_ASK_PASSWORD_SINCE = 257;

/**
 * The flags `systemd-inhibit --version` output calls for, or undefined when it names no version:
 * then a hold could raise a password dialog, so none is tried.
 */
export const inhibitorFlagsFor = (versionOutput: string): ReadonlyArray<string> | undefined => {
  const version = /^systemd (\d+)/.exec(versionOutput.trim())?.[1];
  if (version === undefined) return undefined;
  return Number(version) >= NO_ASK_PASSWORD_SINCE ? ["--no-ask-password"] : [];
};

/** Flags that keep `systemd-inhibit` from raising a password dialog; undefined skips the hold. */
export const linuxInhibitorFlags = Effect.fn("t3f.linuxInhibitorFlags")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const version = yield* spawner
    .string(
      ChildProcess.make("systemd-inhibit", ["--version"], {
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    )
    .pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  const flags = inhibitorFlagsFor(version);
  if (flags === undefined) {
    yield* Effect.logWarning("keep-awake is off: the systemd-inhibit version could not be read");
  }
  return flags;
});
