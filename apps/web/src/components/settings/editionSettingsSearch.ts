import { msg } from "gt-react";

import type { SettingsSearchItem } from "./settingsSearch";

export const EDITION_SETTINGS_SEARCH_ITEMS = [
  {
    id: "link-messages",
    title: msg("Messages from linked machines"),
    to: "/settings/edition",
    searchTerms: ["linked machine environment read only message send threads permission"],
  },
  {
    id: "close-button",
    title: msg("Close button", { $context: "window control" }),
    to: "/settings/edition",
    searchTerms: ["window close x quit keep running background hide tray ask confirmation"],
    desktopOnly: true,
    nonMacOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
