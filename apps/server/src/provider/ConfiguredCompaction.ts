import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  resolveIdleCompaction,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { readClaudeLaunchArgSettings } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexAutoCompactTokenLimit, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

/** What a provider entry launches its provider with about compaction. Absent means not known. */
export interface ConfiguredCompaction {
  readonly compactsAutomatically?: boolean;
  readonly autoCompactThreshold?: number;
  readonly idleCompaction?: {
    readonly mode: "onHumanSend" | "beforeCacheExpires" | "off";
    readonly minTokens?: number;
  };
}

const NOTHING_KNOWN: ConfiguredCompaction = {};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

// Claude Code turns auto-compact off when either is set, whatever autoCompactEnabled says.
const CLAUDE_COMPACT_SWITCHES = ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"] as const;
const claudeEnvTruthy = (value: string) =>
  ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

type ProviderEntry = ServerSettings["providerInstances"][ProviderInstanceId];

interface ReadInput {
  readonly settings: ServerSettings;
  readonly driver: ProviderDriverKind;
  /** The active provider thread's entry. */
  readonly instanceId: ProviderInstanceId;
  /** The app thread's entry, which decides T3 Code's idle compaction. */
  readonly threadInstanceId: ProviderInstanceId;
  /** The turn's cwd, which a relative `--settings` path resolves against. */
  readonly cwd: string | null;
  /** The host environment drivers launch from, after the managed policy. */
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

const claudeIdleCompaction = (input: ReadInput): ConfiguredCompaction["idleCompaction"] => {
  if (input.threadInstanceId !== input.instanceId) return undefined;
  const mode = resolveIdleCompaction(input.settings, input.instanceId);
  return mode === "off"
    ? { mode }
    : {
        mode: mode === "onReturn" ? "onHumanSend" : mode,
        minTokens: COMPACTION_SUGGESTION_MIN_TOKENS,
      };
};

const readClaudeCompaction = Effect.fn("ConfiguredCompaction.readClaude")(function* (
  input: ReadInput,
  entry: ProviderEntry | undefined,
) {
  const idleCompaction = claudeIdleCompaction(input);
  const idle = idleCompaction === undefined ? NOTHING_KNOWN : { idleCompaction };
  const config = Option.getOrUndefined(decodeClaudeSettings(entry?.config ?? {}));
  if (config === undefined) return idle;
  const launch = yield* readClaudeLaunchArgSettings({
    settings: config,
    cwd: input.cwd,
    fileSystem: input.fileSystem,
    path: input.path,
  }).pipe(
    Effect.map((settings) => ({ settings })),
    // The cause can quote the settings, secrets included.
    Effect.catch((error) =>
      Effect.logDebug("Claude --settings unreadable for compaction", {
        instanceId: input.instanceId,
        path: error.path,
      }).pipe(Effect.as(undefined)),
    ),
  );
  if (launch === undefined) return idle;
  // Only where the entry sets them: --settings env, then the entry's environment. Claude's own
  // settings files and the host environment are not read.
  const switches = CLAUDE_COMPACT_SWITCHES.map((name) => {
    const fromSettings = launch.settings?.env?.[name];
    return typeof fromSettings === "string"
      ? fromSettings
      : entry?.environment?.find((variable) => variable.name === name)?.value;
  });
  const enabled = launch.settings?.autoCompactEnabled;
  const compactsAutomatically = switches.some(
    (value) => typeof value === "string" && claudeEnvTruthy(value),
  )
    ? false
    : // A switch held in a secret cannot be read here.
      switches.some((value) => value !== undefined && typeof value !== "string")
      ? undefined
      : typeof enabled === "boolean"
        ? enabled
        : undefined;
  return compactsAutomatically === undefined ? idle : { ...idle, compactsAutomatically };
});

const readCodexCompaction = (
  input: ReadInput,
  entry: ProviderEntry | undefined,
): ConfiguredCompaction => {
  const config = Option.getOrUndefined(decodeCodexSettings(entry?.config ?? {}));
  // A managed setup launches with arguments of its own.
  if (config === undefined || config.setupMode === "managed") return NOTHING_KNOWN;
  const variables = entry?.environment ?? [];
  // An override held in a secret replaces the launch arguments with a value unread here.
  if (
    variables.some(
      (variable) =>
        variable.name === "T3CODE_CODEX_LAUNCH_ARGS" && typeof variable.value !== "string",
    )
  ) {
    return NOTHING_KNOWN;
  }
  const environment = Object.fromEntries(
    variables.flatMap((variable) =>
      typeof variable.value === "string" ? [[variable.name, variable.value]] : [],
    ),
  );
  const autoCompactThreshold = codexAutoCompactTokenLimit(
    resolveCodexLaunchArgs(config.launchArgs, { ...input.hostEnvironment, ...environment }),
  );
  return autoCompactThreshold === undefined ? NOTHING_KNOWN : { autoCompactThreshold };
};

/**
 * Reads the compaction values a provider entry configures, only where their meaning is verified
 * in the provider's code or docs. Other drivers configure nothing known here.
 */
export const readConfiguredCompaction = Effect.fn("ConfiguredCompaction.read")(function* (
  input: ReadInput,
) {
  const entry = Object.hasOwn(input.settings.providerInstances, input.instanceId)
    ? input.settings.providerInstances[input.instanceId]
    : undefined;
  // A removed custom entry launches nothing; only a driver's default instance needs no entry.
  if (entry === undefined && input.instanceId !== defaultInstanceIdForDriver(input.driver)) {
    return NOTHING_KNOWN;
  }
  if (entry !== undefined && entry.driver !== input.driver) return NOTHING_KNOWN;
  switch (input.driver) {
    case "claudeAgent":
      return yield* readClaudeCompaction(input, entry);
    case "codex":
      return readCodexCompaction(input, entry);
    default:
      return NOTHING_KNOWN;
  }
});
