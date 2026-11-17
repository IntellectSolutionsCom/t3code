import { describe, expect, it } from "@effect/vitest";

import { claudeSessionName, codexSessionName, piSessionName } from "./nativeSessionNames.ts";

const lines = (...records: ReadonlyArray<unknown>) =>
  records.map((record) => JSON.stringify(record)).join("\n");

describe("reading the name a provider's own client shows", () => {
  it("is Claude's last custom title, and an empty rename clears it", () => {
    const transcript = lines(
      { type: "custom-title", customTitle: "First name", sessionId: "s" },
      { type: "user", message: { role: "user", content: "custom-title" } },
      { type: "custom-title", customTitle: "Renamed in the terminal", sessionId: "s" },
    );
    expect(claudeSessionName(transcript)).toBe("Renamed in the terminal");
    expect(
      claudeSessionName(`${transcript}\n${lines({ type: "custom-title", customTitle: " " })}`),
    ).toBeNull();
    expect(claudeSessionName(`{"type":"custom-title","custom`)).toBeNull();
    expect(claudeSessionName(lines({ type: "ai-title", aiTitle: "Guessed" }))).toBeNull();
  });

  it("is the newest nonempty Codex thread name for the session", () => {
    const index = lines(
      { id: "t1", thread_name: "Old", updated_at: "2026-11-01T00:00:00Z" },
      { id: "t2", thread_name: "Other thread", updated_at: "2026-11-02T00:00:00Z" },
      { id: "t1", thread_name: "New", updated_at: "2026-11-03T00:00:00Z" },
      { id: "t1", thread_name: "  ", updated_at: "2026-11-04T00:00:00Z" },
    );
    expect(codexSessionName(index, "t1")).toBe("New");
    expect(codexSessionName(index, "t3")).toBeNull();
  });

  it("is Pi's latest session_info name, and an empty name clears it", () => {
    const session = lines(
      { type: "session", id: "root" },
      { type: "session_info", id: "a", parentId: "root", name: "Named" },
      { type: "message", id: "b", parentId: "a" },
      { type: "session_info", id: "c", parentId: "b", name: "Renamed" },
    );
    expect(piSessionName(session)).toBe("Renamed");
    expect(
      piSessionName(`${session}\n${lines({ type: "session_info", id: "d", name: "" })}`),
    ).toBeNull();
  });
});
