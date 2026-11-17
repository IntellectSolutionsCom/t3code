import { describe, expect, it } from "@effect/vitest";

import { nativeSessionCommand } from "./nativeSessionCommand.ts";

const uuid = "5a3356c8-4ff1-46f9-908c-637454f147c4";

describe("the command that continues a session in the provider's own client", () => {
  it.each([
    {
      case: "Claude on the default home",
      input: { driver: "claudeAgent", nativeId: uuid, cwd: "/home/user/app", home: null },
      posix: `cd /home/user/app && claude --resume ${uuid}`,
      powershell: `Set-Location -LiteralPath '/home/user/app'; claude --resume ${uuid}`,
    },
    {
      case: "Claude on its own config dir",
      input: {
        driver: "claudeAgent",
        nativeId: uuid,
        cwd: "/home/user/app",
        home: "/home/user/.claude-work",
      },
      posix: `cd /home/user/app && CLAUDE_CONFIG_DIR=/home/user/.claude-work claude --resume ${uuid}`,
      powershell: `Set-Location -LiteralPath '/home/user/app'; $env:CLAUDE_CONFIG_DIR = '/home/user/.claude-work'; claude --resume ${uuid}`,
    },
    {
      case: "Codex on its own home",
      input: {
        driver: "codex",
        nativeId: "019a-thread",
        cwd: "C:\\Users\\user\\app",
        home: "C:\\Users\\user\\.codex-work",
      },
      posix: `cd 'C:\\Users\\user\\app' && CODEX_HOME='C:\\Users\\user\\.codex-work' codex resume 019a-thread`,
      powershell: `Set-Location -LiteralPath 'C:\\Users\\user\\app'; $env:CODEX_HOME = 'C:\\Users\\user\\.codex-work'; codex resume 019a-thread`,
    },
    {
      case: "Pi by its session file, whose path has a space and a quote",
      input: {
        driver: "pi",
        nativeId: "/home/user/.pi/agent/sessions/it's here/s.jsonl",
        cwd: "/home/user/my app",
        home: null,
      },
      posix: `cd '/home/user/my app' && pi --session '/home/user/.pi/agent/sessions/it'\\''s here/s.jsonl'`,
      powershell: `Set-Location -LiteralPath '/home/user/my app'; pi --session '/home/user/.pi/agent/sessions/it''s here/s.jsonl'`,
    },
    {
      case: "a value that looks like an option",
      input: { driver: "codex", nativeId: "$(rm -rf ~)", cwd: "/w", home: null },
      posix: `cd /w && codex resume '$(rm -rf ~)'`,
      powershell: `Set-Location -LiteralPath '/w'; codex resume '$(rm -rf ~)'`,
    },
  ])("$case", ({ input, posix, powershell }) => {
    expect(nativeSessionCommand({ ...input, shell: "posix" })).toBe(posix);
    expect(nativeSessionCommand({ ...input, shell: "powershell" })).toBe(powershell);
  });

  it.each(["cursor", "opencode", "grok", "kiro", "antigravity", "muse", "acpRegistry", "replay"])(
    "is not offered for %s, whose command is not yet verified",
    (driver) => {
      expect(
        nativeSessionCommand({ driver, nativeId: uuid, cwd: "/w", home: null, shell: "posix" }),
      ).toBeNull();
    },
  );
});
