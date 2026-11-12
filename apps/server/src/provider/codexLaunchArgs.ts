import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

// T3 unsubscribes only when it unloads a thread; Codex's own unload delay would stack on that.
export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  ...codexLaunchArgv(launchArgs),
];

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (launchArgs: string | undefined, allowed: LaunchArgFilter) => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

const HOOK_FEATURES = new Set(["hooks", "codex_hooks"]);

// Feature toggles beat config overrides, so a launch arg's hook enable would undo ours.
export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = filterLaunchArgs(launchArgs, EXEC_FILTER);
  return args.filter((arg, index) => {
    if (arg.startsWith("--enable=")) return !HOOK_FEATURES.has(arg.slice("--enable=".length));
    if (arg === "--enable") return !HOOK_FEATURES.has(args[index + 1] ?? "");
    return !(args[index - 1] === "--enable" && HOOK_FEATURES.has(arg));
  });
};

export const codexMcpListLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, MCP_LIST_FILTER);

const CODEX_TOML_INTEGER = /^\+?\d+(?:_\d+)*$/;

/** The last `-c`/`--config` override of `key` in Codex launch arguments, as written. */
const codexConfigOverride = (launchArgs: string | undefined, key: string) => {
  const args = codexLaunchArgv(launchArgs);
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const override =
      arg === "-c" || arg === "--config"
        ? args[++index]
        : arg.startsWith("-c=") || arg.startsWith("--config=")
          ? arg.slice(arg.indexOf("=") + 1)
          : undefined;
    const separator = override?.indexOf("=") ?? -1;
    if (override === undefined || separator === -1) continue;
    if (override.slice(0, separator).trim() === key) value = override.slice(separator + 1).trim();
  }
  return value;
};

/** Codex's `model_auto_compact_token_limit` from `-c`/`--config` overrides; the last one wins. */
export const codexAutoCompactTokenLimit = (launchArgs?: string): number | undefined => {
  const scope = codexConfigOverride(launchArgs, "model_auto_compact_token_limit_scope");
  // Under `body_after_prefix` the limit does not count the whole context.
  if (scope !== undefined && scope.replace(/^"(.*)"$/, "$1") !== "total") return undefined;
  const value = codexConfigOverride(launchArgs, "model_auto_compact_token_limit");
  return value !== undefined && CODEX_TOML_INTEGER.test(value)
    ? Number(value.replaceAll("_", ""))
    : undefined;
};
