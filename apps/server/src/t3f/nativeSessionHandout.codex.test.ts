// @effect-diagnostics nodeBuiltinImport:off -- Runs a fake app-server and probes its flock from another process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as PortScanner from "../preview/PortScanner.ts";

// Codex guards each loaded thread with an advisory flock on this file, held by the app-server.
const FAKE_CODEX = `#!/usr/bin/env python3
import fcntl, os, time
home = os.environ["CODEX_HOME"]
lock = open(os.path.join(home, "thread-writer-locks", "native-thread.lock"), "w")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(os.path.join(home, "locked"), "w") as locked:
    locked.write("locked")
time.sleep(600)
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const lockIsFree = (lockPath: string) =>
  NodeChildProcess.spawnSync("python3", [
    "-c",
    "import fcntl, sys; fcntl.flock(open(sys.argv[1], 'a'), fcntl.LOCK_EX | fcntl.LOCK_NB)",
    lockPath,
  ]).status === 0;

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "frees Codex's thread writer lock when the session is released",
  () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3f-codex-lock-"));
    NodeFS.mkdirSync(NodePath.join(home, "thread-writer-locks"));
    const lockPath = NodePath.join(home, "thread-writer-locks", "native-thread.lock");
    const binaryPath = NodePath.join(home, "codex");
    NodeFS.writeFileSync(binaryPath, FAKE_CODEX, { mode: 0o755 });
    NodeChildProcess.spawnSync("mkfifo", [NodePath.join(home, "locked")]);
    const settings = decodeCodexSettings({ binaryPath, homePath: home });
    const environment = { PATH: process.env.PATH };
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true })),
      );
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* factory.open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-codex-lock"),
            providerSessionId: ProviderSessionId.make("session-codex-lock"),
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: home,
            }),
            settings,
            environment,
          });
          yield* Effect.promise(() =>
            NodeFS.promises.readFile(NodePath.join(home, "locked"), "utf8"),
          );
          assert.isFalse(lockIsFree(lockPath));
        }),
      );
      assert.isTrue(lockIsFree(lockPath));
    }).pipe(
      Effect.provide(
        CodexAdapterV2.layerAppServerClientFactory.pipe(
          Layer.provide(Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => {} })),
          Layer.provide(
            Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
              native: undefined,
              canonical: undefined,
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);
