import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

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
