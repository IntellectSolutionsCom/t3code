export type NativeSessionShell = "posix" | "powershell";

interface ResumeCommand {
  readonly homeVariable: string | null;
  readonly argv: (nativeId: string) => ReadonlyArray<string>;
}

// Only commands checked against each vendor's CLI reference; others wait for a probe.
const RESUME_COMMANDS: Readonly<Record<string, ResumeCommand>> = {
  claudeAgent: { homeVariable: "CLAUDE_CONFIG_DIR", argv: (id) => ["claude", "--resume", id] },
  codex: { homeVariable: "CODEX_HOME", argv: (id) => ["codex", "resume", id] },
  pi: { homeVariable: null, argv: (path) => ["pi", "--session", path] },
};

export const hasVerifiedCommand = (driver: string): boolean =>
  Object.hasOwn(RESUME_COMMANDS, driver);

const posixQuote = (value: string) =>
  /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const powershellArg = (value: string) =>
  /^[\w./:@%+=,-]+$/.test(value) ? value : powershellQuote(value);

export const nativeSessionCommand = (input: {
  readonly driver: string;
  readonly nativeId: string;
  readonly cwd: string;
  /** The instance's home when it is not the provider's default. */
  readonly home: string | null;
  readonly shell: NativeSessionShell;
}): string | null => {
  const command = RESUME_COMMANDS[input.driver];
  if (command === undefined) return null;
  const argv = command.argv(input.nativeId);
  const home = command.homeVariable !== null && input.home !== null ? input.home : null;
  if (input.shell === "powershell") {
    return [
      `Set-Location -LiteralPath ${powershellQuote(input.cwd)}`,
      ...(home === null ? [] : [`$env:${command.homeVariable} = ${powershellQuote(home)}`]),
      argv.map(powershellArg).join(" "),
    ].join("; ");
  }
  const env = home === null ? "" : `${command.homeVariable}=${posixQuote(home)} `;
  return `cd ${posixQuote(input.cwd)} && ${env}${argv.map(posixQuote).join(" ")}`;
};
