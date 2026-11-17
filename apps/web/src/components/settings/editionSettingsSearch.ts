import { CLOSE_BUTTON_TEXT } from "@t3tools/shared/closeButtonText";

import type { SettingsSearchItem } from "./settingsSearch";

export const EDITION_SETTINGS_SEARCH_ITEMS = [
  {
    id: "link-messages",
    title: "Messages from linked machines",
    to: "/settings/edition",
    searchTerms: ["linked machine environment read only message send threads permission"],
  },
  {
    id: "close-button",
    title: CLOSE_BUTTON_TEXT.setting.title,
    to: "/settings/edition",
    searchTerms: ["window close x quit keep running background hide tray ask confirmation"],
    desktopOnly: true,
    nonMacOnly: true,
  },
  {
    id: "native-session-label",
    title: "Show the session name above the composer",
    to: "/settings/edition",
    searchTerms: ["native session name label composer provider client terminal resume thread"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
