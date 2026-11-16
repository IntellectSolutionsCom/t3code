import { describe, expect, it } from "vite-plus/test";

import { EDITION_LINUX_DESKTOP_ID, EDITION_PACKAGE_NAME } from "./edition.ts";

describe("edition identity", () => {
  // GNOME matches windows to launchers by this id, and D-Bus-style names reject a hyphen.
  it("names the Linux desktop entry in D-Bus form", () => {
    expect(EDITION_LINUX_DESKTOP_ID).toMatch(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/);
  });

  it("names the package the way dpkg and the Windows install folder accept", () => {
    expect(EDITION_PACKAGE_NAME).toMatch(/^[a-z0-9][a-z0-9+.-]+$/);
  });
});
