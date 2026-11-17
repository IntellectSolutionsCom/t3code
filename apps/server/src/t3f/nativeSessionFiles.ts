import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

const CODEX_THREAD_ID_PATTERN =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;

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
