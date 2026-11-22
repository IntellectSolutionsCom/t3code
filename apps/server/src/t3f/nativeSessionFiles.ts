import {
  ClaudeSettings,
  CodexSettings,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { completeTail } from "./outsideTurns.ts";

const CODEX_THREAD_ID_PATTERN =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f-]{36}))?\.jsonl(?:\.zst)?$/i;

const baseName = (filePath: string) =>
  filePath.slice(filePath.replace(/\\/g, "/").lastIndexOf("/") + 1);

/** One provider session to scan for, whatever its age. */
export interface NativeSessionKey {
  readonly providerInstanceId: ProviderInstanceId;
  /** From `nativeIdFileKey`. */
  readonly fileKey: string;
}

/** A scan for listing or adopting reads the transcripts afresh. */
export interface NativeSessionScan {
  readonly session: NativeSessionKey | null;
}

/**
 * The part of a transcript's file name that names its session: Claude's session id and the Codex
 * thread id (shared by its rewound rollouts). Pi's session is its file, matched by real path.
 */
export const nativeSessionFileKey = (source: string, filePath: string): string | null => {
  if (source === "codex") return CODEX_THREAD_ID_PATTERN.exec(filePath)?.[1]?.toLowerCase() ?? null;
  const name = baseName(filePath);
  if (source === "claudeAgent") return name.endsWith(".jsonl") ? name.slice(0, -6) : null;
  return null;
};

/** The file key of a session named by its native id: Pi's is the session file's real path. */
export const nativeIdFileKey = (driver: string, nativeId: string): string | null => {
  if (driver === "pi") return nativeId;
  if (driver === "codex") return nativeId.toLowerCase();
  if (driver === "claudeAgent") return nativeId;
  return null;
};

// Untraced: it runs once per transcript the scanner finds.
export const matchesNativeSession = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  scan: NativeSessionScan | undefined,
  transcript: { readonly source: string; readonly providerInstanceId: ProviderInstanceId },
  filePath: string,
) {
  const session = scan?.session;
  if (session === null || session === undefined) return true;
  if (session.providerInstanceId !== transcript.providerInstanceId) return false;
  if (transcript.source !== "pi") {
    return nativeSessionFileKey(transcript.source, filePath) === session.fileKey;
  }
  if (baseName(filePath) !== baseName(session.fileKey)) return false;
  const realPath = yield* fileSystem.realPath(filePath).pipe(Effect.orElseSucceed(() => filePath));
  return realPath === session.fileKey;
});

const NO_HOME = { run: null, state: null } as const;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/** Where the session runs and where its state lives; null where that is the provider's default. */
export const instanceHome = Effect.fn("NativeSessions.instanceHome")(function* (
  driver: string,
  instance: ProviderInstanceConfig | undefined,
) {
  const home = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
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

export const instanceOf = (
  settings: ServerSettingsValue,
  providerThread: OrchestrationV2ProviderThread,
): ProviderInstanceConfig | undefined =>
  settings.providerInstances[providerThread.providerInstanceId] ??
  (providerThread.providerInstanceId === ProviderInstanceId.make(providerThread.driver)
    ? { driver: providerThread.driver }
    : undefined);

const listDirectory = (fs: FileSystem.FileSystem, directory: string) =>
  fs
    .readDirectory(directory)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));

export const findClaudeTranscript = Effect.fn("NativeSessionFiles.findClaudeTranscript")(function* (
  home: string,
  nativeId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (baseName(nativeId) !== nativeId) return undefined;
  const projects = path.join(home, "projects");
  // Claude can hash its project folder name. The root transcript always has the session's name.
  for (const entry of yield* listDirectory(fs, projects)) {
    const candidate = path.join(projects, entry, `${nativeId}.jsonl`);
    if (yield* fs.exists(candidate)) return candidate;
  }
  return undefined;
});

const findCodexRollout = Effect.fn("NativeSessionFiles.findCodexRollout")(function* (
  home: string,
  nativeId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessions = path.join(home, "sessions");
  const key = nativeIdFileKey("codex", nativeId);
  // Rewinds can create a newer rollout for the same thread in a different day directory.
  for (const year of (yield* listDirectory(fs, sessions)).toSorted().reverse()) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = path.join(sessions, year);
    for (const month of (yield* listDirectory(fs, yearDir)).toSorted().reverse()) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthDir = path.join(yearDir, month);
      for (const day of (yield* listDirectory(fs, monthDir)).toSorted().reverse()) {
        if (!/^\d{2}$/.test(day)) continue;
        const directory = path.join(monthDir, day);
        const entry = (yield* listDirectory(fs, directory))
          .toSorted()
          .findLast(
            (entry) => entry.startsWith("rollout-") && nativeSessionFileKey("codex", entry) === key,
          );
        if (entry !== undefined) return path.join(directory, entry);
      }
    }
  }
  return undefined;
});

export const NATIVE_SESSION_TAIL_BYTES = 2 * 1024 * 1024;

/** An open file whose last records can be read, after its first `headBytes` when the two do not overlap. */
export const openTail = Effect.fn("NativeSessions.openTail")(function* (
  filePath: string,
  { headBytes = 0, size: knownSize }: { readonly headBytes?: number; readonly size?: number } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(filePath, { flag: "r" });
  const size = knownSize ?? Number((yield* file.stat).size);
  const read = (bytes: number) =>
    file.readAlloc(bytes).pipe(
      Effect.map(
        Option.match({
          onNone: () => "",
          onSome: (chunk) => new TextDecoder().decode(chunk),
        }),
      ),
    );
  return {
    size,
    window: Effect.fn("NativeSessions.readWindow")(function* (windowBytes: number) {
      const start = Math.max(0, size - windowBytes);
      if (start <= headBytes) {
        yield* file.seek(0n, "start");
        return yield* read(size);
      }
      const head = headBytes > 0 ? yield* read(headBytes) : "";
      yield* file.seek(BigInt(start), "start");
      const tail = yield* read(size - start);
      // Both reads can end or start mid-record.
      const firstBreak = tail.indexOf("\n");
      return completeTail(head) + (firstBreak === -1 ? "" : tail.slice(firstBreak + 1));
    }),
  };
});

export const readTail = (filePath: string, options?: Parameters<typeof openTail>[1]) =>
  Effect.scoped(
    openTail(filePath, options).pipe(
      Effect.flatMap((file) => file.window(NATIVE_SESSION_TAIL_BYTES)),
    ),
  );

export const readOutsideTurnTail = Effect.fn("NativeSessionFiles.readOutsideTurnTail")(function* (
  providerThread: Pick<OrchestrationV2ProviderThread, "driver">,
  nativeId: string,
  instance: ProviderInstanceConfig | undefined,
  completedAt: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const { driver } = providerThread;
  const { state } = yield* instanceHome(driver, instance);
  const filePath =
    driver === "claudeAgent"
      ? yield* findClaudeTranscript(state ?? path.join(home, ".claude"), nativeId)
      : yield* findCodexRollout(state ?? path.join(home, ".codex"), nativeId);
  if (filePath === undefined || filePath.endsWith(".zst")) return undefined;
  // The rewind suffix remains visible when the tail omits session_meta.history_base.
  if (driver === "codex" && CODEX_THREAD_ID_PATTERN.exec(filePath)?.[2] !== undefined)
    return undefined;
  const { size, mtime, type } = yield* fs.stat(filePath);
  if (type !== "File" || Option.isNone(mtime) || mtime.value.getTime() <= completedAt)
    return undefined;
  return yield* readTail(filePath, { size: Number(size) }).pipe(Effect.map(completeTail));
});
