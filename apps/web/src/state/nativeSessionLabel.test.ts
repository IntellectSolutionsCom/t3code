import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function stubStorage(stored: string | null, failing = false) {
  const storage = {
    getItem: () => {
      if (failing) throw new Error("storage unavailable");
      return stored;
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("composer session name switch", () => {
  it.each([
    ["off when never set", null, false, false],
    ["on when turned on", "true", false, true],
    ["off when the stored value is garbled", "{not json", false, false],
    ["off when the stored value is not a boolean", '"yes"', false, false],
    ["off when storage throws", "true", true, false],
  ])("is %s", async (_, stored, failing, expected) => {
    stubStorage(stored, failing);
    using _error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { readNativeSessionLabelSwitch } = await import("./nativeSessionLabel");
    expect(readNativeSessionLabelSwitch()).toBe(expected);
  });
});
