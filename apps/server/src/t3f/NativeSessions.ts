import {
  CommandId,
  type OrchestrationV2ProviderThread,
  T3fNativeSessionError,
  type ProjectId,
  type T3fNativeSessionAdoptInput,
  type T3fNativeSessionAdoptResult,
  type T3fNativeSessionIdentifyResult,
  type T3fNativeSessionListResult,
  type T3fNativeSessionOutThreads,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAdoption } from "./nativeSessionAdoption.ts";
import {
  findClaudeTranscript,
  instanceHome,
  instanceOf,
  NATIVE_SESSION_TAIL_BYTES,
  openTail,
  readTail,
} from "./nativeSessionFiles.ts";
import { makeHandout } from "./nativeSessionHandout.ts";
import * as NativeSessionKnownNames from "./NativeSessionKnownNames.ts";
import * as NativeSessionOut from "./NativeSessionOut.ts";
import { namedSessionId, NativeSessionTitleSync } from "./NativeSessionTitleSync.ts";
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
    /** Releases the thread's session so its provider's own client can continue it. */
    readonly handOut: (
      threadId: ThreadId,
    ) => Effect.Effect<T3fNativeSessionIdentifyResult, T3fNativeSessionError>;
    /** Lets T3 Code send to the thread again; a thread that is not out is left as it is. */
    readonly takeBack: (threadId: ThreadId) => Effect.Effect<void, T3fNativeSessionError>;
    /** This environment's out threads now, then after each change. */
    readonly outThreads: Stream.Stream<T3fNativeSessionOutThreads>;
  }
>()("t3/t3f/NativeSessions") {}

const COMMAND_NOTE =
  "Continuing this session in the provider's own client is not yet verified, so no command is shown.";
// The index is shared by every session, so a miss in the tail reads on up to this much.
const CODEX_INDEX_MAX_BYTES = 64 * 1024 * 1024;
// Pi writes a session's first name at its start, which upstream's scanner reads in this window.
const PI_NAME_HEAD_BYTES = 32 * 1024;

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
  const handout = yield* makeHandout;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const fileServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  /** A name, null when the session is confirmed to have none, or a failure when it cannot be told. */
  const readName = Effect.fn("NativeSessions.readName")(function* (
    providerThread: OrchestrationV2ProviderThread,
    nativeId: string,
    home: string | null,
  ) {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    switch (providerThread.driver) {
      case "claudeAgent": {
        const located = yield* findClaudeTranscript(
          home ?? path.join(homeDirectory, ".claude"),
          nativeId,
        );
        if (located === undefined) return null;
        return yield* readTail(located).pipe(
          Effect.map(claudeSessionName),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
        );
      }
      case "codex": {
        const index = path.join(home ?? path.join(homeDirectory, ".codex"), "session_index.jsonl");
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const { size, window } = yield* openTail(index);
            const tail = codexSessionName(yield* window(NATIVE_SESSION_TAIL_BYTES), nativeId);
            if (tail !== null || size <= NATIVE_SESSION_TAIL_BYTES) return tail;
            // Other sessions can push this one's last name out of the tail.
            const wider = codexSessionName(yield* window(CODEX_INDEX_MAX_BYTES), nativeId);
            if (wider === null && size > CODEX_INDEX_MAX_BYTES) {
              return yield* new T3fNativeSessionError({
                reason: "storage",
                message: "The session index is too large to search for this session's name.",
              });
            }
            return wider;
          }),
        ).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
      }
      case "pi":
        return piSessionName(yield* readTail(nativeId, { headBytes: PI_NAME_HEAD_BYTES }));
      default:
        return providerThread.nativeMetadata?.title?.trim() || null;
    }
  });

  /** The thread's session and the explicit name it was given there, if the thread has one. */
  const explicitName = Effect.fn("NativeSessions.explicitName")(function* (
    threadId: ThreadId,
    skipPendingTitle = false,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return undefined;
    if (skipPendingTitle && shell.titleRegeneration != null) return undefined;
    const { providerThreads } = yield* threads.getProjectThreadRecords(
      { projectId: shell.projectId, threadId },
      ["providerThreads"],
    );
    const active = providerThreads.find(
      (providerThread) => providerThread.id === shell.activeProviderThreadId,
    );
    const nativeId = namedSessionId(active);
    if (active === undefined || nativeId === undefined) return undefined;
    const settings = yield* serverSettings.getSettings;
    const home = yield* instanceHome(active.driver, instanceOf(settings, active)).pipe(
      Effect.provide(fileServices),
    );
    const native = (yield* readName(active, nativeId, home.state).pipe(
      Effect.provide(fileServices),
    ))?.trim();
    return native ? { shell, active, nativeId, native } : undefined;
  });

  const titleSync = yield* NativeSessionTitleSync;
  const known = yield* NativeSessionKnownNames.NativeSessionKnownNames;
  /**
   * An explicit native name T3 Code does not know is an outside rename, and it becomes the title.
   * Resolves to the name when it renamed the thread; every failure leaves things as they are.
   */
  const syncNativeName = Effect.fn("NativeSessions.syncNativeName")(
    function* (threadId: ThreadId) {
      const found = yield* explicitName(threadId, true);
      if (found === undefined) return undefined;
      const { shell, active, nativeId, native } = found;
      if (native === shell.title.trim()) {
        yield* known.add(threadId, nativeId, native);
        return undefined;
      }
      // Claude persists the title its adapter last applied, which covers a /rename made in a turn.
      const applied = active.driver === "claudeAgent" ? active.nativeMetadata?.title?.trim() : "";
      if (native === applied || (yield* known.get(threadId, nativeId)).includes(native)) {
        return undefined;
      }
      // Each rename is its own command; a repeated id would replay the receipt of an earlier one.
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`native-name-sync:${threadId}:${SecureRandom.uuidV4Unsafe()}`),
        threadId,
        title: native,
      });
      yield* known.add(threadId, nativeId, native);
      return native;
    },
    (effect, threadId) => {
      const skipped = (cause: unknown) =>
        Effect.logWarning("A thread's title could not be matched to its native session.", {
          threadId,
          cause,
        }).pipe(Effect.as(undefined));
      return effect.pipe(Effect.catch(skipped), Effect.catchDefect(skipped));
    },
  );
  yield* titleSync.bind(syncNativeName);

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
    const home = yield* instanceHome(active.driver, instanceOf(settings, active)).pipe(
      Effect.provide(fileServices),
    );
    const name = yield* readName(active, nativeId, home.state).pipe(
      Effect.provide(fileServices),
      Effect.orElseSucceed(() => null),
    );
    const platform = yield* HostProcess.Platform;
    const mark = yield* handout.mark(threadId);
    if (mark !== undefined && mark.nativeId !== nativeId) {
      yield* handout.dropMark(threadId).pipe(Effect.ignore);
    }
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
        out: mark?.nativeId === nativeId ? { since: mark.since } : null,
      },
    };
  });

  const { list, adopt } = yield* makeAdoption((threadId) =>
    explicitName(threadId).pipe(Effect.orElseSucceed(() => undefined)),
  );
  return NativeSessions.of({
    identify,
    list,
    adopt,
    handOut: Effect.fn("NativeSessions.handOut")(function* (threadId: ThreadId) {
      yield* handout.handOut(threadId);
      return yield* identify(threadId);
    }),
    takeBack: handout.takeBack,
    outThreads: handout.outThreads,
  });
});

// Upstream provides the ACP session service per connection; this layer also serves tools.
export const layer = Layer.effect(NativeSessions, make).pipe(
  Layer.provide(
    Layer.mergeAll(
      AcpRegistrySessions.layer,
      NativeSessionOut.layer,
      ThreadCommandExecutor.layer,
      RuntimeLayer.layerEventSink,
      IdAllocator.layer,
    ),
  ),
);
