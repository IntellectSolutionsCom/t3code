import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
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
  const gt = useGT();
  const takeBack = useTakeBack(ref);
  if (takeBack === null) return NONE;
  return [
    {
      id: "native-session-out",
      variant: "info",
      icon: <TerminalIcon />,
      title: gt("In terminal · paused here since {time}", {
        time: formatDayAwareTimestamp(takeBack.out.since, timestampFormat),
      }),
      description: gt("Move it back to send from here."),
      actions: (
        <Button size="xs" variant="ghost" onClick={() => void takeBack.takeBack()}>
          {gt("Move back")}
        </Button>
      ),
    },
  ];
}
