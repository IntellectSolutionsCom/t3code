import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";
import { memo } from "react";

import { useNativeSessionLabelSwitch } from "../../state/nativeSessionLabel";
import { useNativeSession } from "../../state/nativeSessions";
import { ComposerBanner } from "./ComposerBanner";

/** The session's name on the composer's shoulder, behind a switch of its own. */
export const NativeSessionNameLabel = memo(function NativeSessionNameLabel(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [shown] = useNativeSessionLabelSwitch();
  return shown ? (
    <SessionName environmentId={props.environmentId} threadId={props.threadId} />
  ) : null;
});

function SessionName(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  // Named only when the name differs from the thread's title, as in thread details.
  const name = useNativeSession(scopeThreadRef(props.environmentId, props.threadId))?.name ?? null;
  if (name === null) return null;
  return (
    <ComposerBanner.Root density="comfortable" width="content" data-composer-shoulder-tab>
      <ComposerBanner.Row title={`Session name: ${name}`} className="text-muted-foreground">
        <ComposerBanner.Icon>
          <TerminalIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="pe-2">
          <span className="truncate">{name}</span>
        </ComposerBanner.Content>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}
