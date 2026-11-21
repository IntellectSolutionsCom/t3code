import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { inhibitorFlagsFor, linuxInhibitorFlags } from "./inhibitorFlags.ts";

const spawnerPrinting = (output: Stream.Stream<Uint8Array>) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

describe("inhibitorFlagsFor", () => {
  it.each([
    ["systemd 255 (255.4-1ubuntu8)\n+PAM +AUDIT", []],
    ["systemd 256 (256.5)", []],
    ["systemd 257 (257.1-1)", ["--no-ask-password"]],
    ["systemd 259 (259.9-0ubuntu0.1)\n+PAM +AUDIT", ["--no-ask-password"]],
    ["", undefined],
    ["not systemd", undefined],
  ])("%j → %j", (output, expected) => {
    expect(inhibitorFlagsFor(output)).toEqual(expected);
  });
});

describe("linuxInhibitorFlags", () => {
  it.effect("skips the hold when the version probe never answers", () =>
    Effect.gen(function* () {
      const flags = yield* linuxInhibitorFlags().pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          spawnerPrinting(Stream.never),
        ),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(flags)).toBeUndefined();
    }),
  );
});
