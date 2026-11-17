import {
  ClaudeSettings,
  CodexSettings,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  T3fNativeSessionError,
  type ProjectId,
  type T3fNativeSessionAdoptInput,
  type T3fNativeSessionAdoptResult,
  type T3fNativeSessionIdentifyResult,
  type T3fNativeSessionListResult,
  type ThreadId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAdoption } from "./nativeSessionAdoption.ts";
import { hasVerifiedCommand, nativeSessionCommand } from "./nativeSessionCommand.ts";
import { claudeSessionName, codexSessionName, piSessionName } from "./nativeSessionNames.ts";

export class NativeSessions extends Context.Service<
  NativeSessions,
  {
    readonly identify: (
      threadId: ThreadId,
    ) => Effect.Effect<T3fNativeSessionIdentifyResult, T3fNativeSessionError>;
    /** Sessions that ran in the project's folder, with the thread already on each. */
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<T3fNativeSessionListResult, T3fNativeSessionError>;
    /** Loads a session into a new thread, or returns the thread already on it. */
    readonly adopt: (
      input: T3fNativeSessionAdoptInput,
    ) => Effect.Effect<T3fNativeSessionAdoptResult, T3fNativeSessionError>;
  }
>()("t3/t3f/NativeSessions") {}

const COMMAND_NOTE =
  "Continuing this session in the provider's own client is not yet verified, so no command is shown.";
// Claude repeats a session's custom title every few records, and Codex names live near the index's end.
const NAME_TAIL_BYTES = 2 * 1024 * 1024;
// Pi writes a session's first name at its start, which upstream's scanner reads in this window.
const PI_NAME_HEAD_BYTES = 32 * 1024;

const NO_HOME = { run: null, state: null } as const;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

const storageError = (cause: unknown) =>
  Effect.logWarning("A thread's native session could not be read.", { cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new T3fNativeSessionError({
          reason: "storage",
          message: "The thread's native session could not be read.",
        }),
      ),
    ),
  );

const threadNotFound = (threadId: ThreadId) =>
  new T3fNativeSessionError({
    reason: "thread_not_found",
    message: `Thread ${threadId} was not found.`,
  });

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The file's last records, after its first `headBytes` when the two do not overlap. */
  const readTail = (filePath: string, headBytes = 0) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const read = (bytes: number) =>
          file.readAlloc(bytes).pipe(
            Effect.map(
              Option.match({
                onNone: () => "",
                onSome: (chunk) => new TextDecoder().decode(chunk),
              }),
            ),
          );
        const start = Math.max(0, size - NAME_TAIL_BYTES);
        if (start <= headBytes) return yield* read(size);
        const head = headBytes > 0 ? yield* read(headBytes) : "";
        yield* file.seek(BigInt(start), "start");
        const tail = yield* read(size - start);
        // Both reads can end or start mid-record.
        return `${head.slice(0, head.lastIndexOf("\n") + 1)}${tail.slice(tail.indexOf("\n") + 1)}`;
      }),
    );

  /** Where the session runs and where its state lives; null where that is the provider's default. */
  const instanceHome = Effect.fn("NativeSessions.instanceHome")(function* (
    driver: string,
    instance: ProviderInstanceConfig | undefined,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* mergeProviderInstanceEnvironment(
      instance?.environment,
      yield* HostProcess.Environment,
    );
    if (driver === "claudeAgent") {
      const config = decodeClaudeSettings(instance?.config ?? {});
      if (Option.isNone(config)) return NO_HOME;
      const resolved = yield* resolveClaudeHomePath(config.value, environment).pipe(
        Effect.provideService(Path.Path, path),
      );
      const custom = resolved === path.resolve(home, ".claude") ? null : resolved;
      return { run: custom, state: custom };
    }
    if (driver === "codex") {
      const config = decodeCodexSettings(instance?.config ?? {});
      if (Option.isNone(config)) return NO_HOME;
      const fromEnvironment = environment.CODEX_HOME?.trim();
      const layout = yield* resolveCodexHomeLayout(
        !config.value.homePath.trim() && fromEnvironment
          ? { ...config.value, homePath: fromEnvironment }
          : config.value,
      ).pipe(Effect.provideService(Path.Path, path));
      const custom = (homePath: string) =>
        homePath === path.resolve(home, ".codex") ? null : homePath;
      // An auth overlay runs in its own home, which links the shared one's session index.
      return {
        run: custom(layout.effectiveHomePath ?? layout.sharedHomePath),
        state: custom(layout.sharedHomePath),
      };
    }
    return NO_HOME;
  });

  const readName = Effect.fn("NativeSessions.readName")(function* (
    providerThread: OrchestrationV2ProviderThread,
    nativeId: string,
    home: string | null,
  ) {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    switch (providerThread.driver) {
      case "claudeAgent": {
        // Claude names the project folder after the resolved, possibly hashed, cwd; find the session instead.
        const projectsDir = path.join(home ?? path.join(homeDirectory, ".claude"), "projects");
        for (const entry of yield* fs.readDirectory(projectsDir)) {
          const candidate = path.join(projectsDir, entry, `${nativeId}.jsonl`);
          if (yield* fs.exists(candidate)) return claudeSessionName(yield* readTail(candidate));
        }
        return null;
      }
      case "codex":
        return codexSessionName(
          yield* readTail(
            path.join(home ?? path.join(homeDirectory, ".codex"), "session_index.jsonl"),
          ),
          nativeId,
        );
      case "pi":
        return piSessionName(yield* readTail(nativeId, PI_NAME_HEAD_BYTES));
      default:
        return providerThread.nativeMetadata?.title?.trim() || null;
    }
  });

  const identify = Effect.fn("NativeSessions.identify")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.catch(storageError));
    if (shell === null || shell.deletedAt !== null) return yield* threadNotFound(threadId);
    const { providerThreads } = yield* threads
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, ["providerThreads"])
      .pipe(
        Effect.catchTags({
          ThreadManagementThreadNotFoundError: () => Effect.fail(threadNotFound(threadId)),
          ThreadManagementProjectionLoadError: storageError,
        }),
      );
    // The current ref, so a session Claude rotated with /clear is the one shown.
    const active = providerThreads.find(
      (providerThread) => providerThread.id === shell.activeProviderThreadId,
    );
    const nativeId = active?.nativeThreadRef?.nativeId;
    if (active === undefined || !nativeId) return { session: null };

    const cwd =
      shell.worktreePath ??
      Option.getOrUndefined(
        yield* projects.getById(shell.projectId).pipe(Effect.catch(storageError)),
      )?.workspaceRoot;
    if (cwd === undefined) return yield* threadNotFound(threadId);

    const settings = yield* serverSettings.getSettings.pipe(Effect.catch(storageError));
    const instance: ProviderInstanceConfig | undefined =
      settings.providerInstances[active.providerInstanceId] ??
      (active.providerInstanceId === ProviderInstanceId.make(active.driver)
        ? { driver: active.driver }
        : undefined);
    const home = yield* instanceHome(active.driver, instance);
    const name = yield* readName(active, nativeId, home.state).pipe(
      Effect.orElseSucceed(() => null),
    );
    const platform = yield* HostProcess.Platform;
    const command = nativeSessionCommand({
      driver: active.driver,
      nativeId,
      cwd,
      home: home.run,
      shell: platform === "win32" ? "powershell" : "posix",
    });
    return {
      session: {
        driver: active.driver,
        providerInstanceId: active.providerInstanceId,
        nativeId,
        name,
        cwd,
        command,
        commandNote: hasVerifiedCommand(active.driver) ? null : COMMAND_NOTE,
      },
    };
  });

  const { list, adopt } = yield* makeAdoption;
  return NativeSessions.of({ identify, list, adopt });
});

// Upstream provides the ACP session service per connection; this layer also serves tools.
export const layer = Layer.effect(NativeSessions, make).pipe(
  Layer.provide(AcpRegistrySessions.layer),
);
