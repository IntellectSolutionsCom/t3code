import { nativeClientName } from "@t3tools/client-runtime/state/nativeSessions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useTakeBack } from "../../state/nativeSessions";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NONE: ReadonlyArray<ComposerBannerStackItem> = [];

/** While the thread is out in its provider's own client, the composer says so. */
export function useNativeSessionOutBanner(
  ref: ScopedThreadRef | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const takeBack = useTakeBack(ref);
  if (takeBack === null) return NONE;
  return [
    {
      id: "native-session-out",
      variant: "info",
      icon: <TerminalIcon />,
      title: `In ${nativeClientName(takeBack.out.driver)} since ${formatDayAwareTimestamp(takeBack.out.since, timestampFormat)}`,
      description: "Take it back to send from here.",
      actions: (
        <Button size="xs" variant="ghost" onClick={() => void takeBack.takeBack()}>
          Take back
        </Button>
      ),
    },
  ];
}
