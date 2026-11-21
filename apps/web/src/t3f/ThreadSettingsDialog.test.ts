import { checkThreadBadge } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { PROJECT_EMOJIS } from "../projectIconOptions";

it("offers only emoji that the server accepts as badge symbols", () => {
  const segmenter = new Intl.Segmenter();
  const countGraphemes = (text: string) => Array.from(segmenter.segment(text)).length;

  for (const { emoji, label } of PROJECT_EMOJIS) {
    const result = checkThreadBadge({ symbol: emoji, label: "Project" }, countGraphemes);
    expect(result.ok, `${label} (${emoji}): ${result.ok ? "" : result.message}`).toBe(true);
  }
});
