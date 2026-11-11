import { useAtomValue } from "@effect/atom-react";
import type { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { memo, useState } from "react";

import { linkMessageGrantEnvironment } from "~/state/linkMessageGrants";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Switch } from "../ui/switch";

/** Shown on a linked environment's row below full access; absent where the server has no grants. */
export const LinkMessageGrantSwitch = memo(function LinkMessageGrantSwitch({
  environmentId,
  sessionId,
}: {
  environmentId: EnvironmentId;
  sessionId: AuthSessionId;
}) {
  const grants = useEnvironmentQuery(
    linkMessageGrantEnvironment.list({ environmentId, input: {} }),
  ).data;
  const canSet = useAtomValue(linkMessageGrantEnvironment.set.permissionAtom(environmentId));
  const setGrant = useAtomCommand(linkMessageGrantEnvironment.set);
  const [saving, setSaving] = useState(false);
  if (grants === null || !grants.supported) return null;
  const link = grants.links.find((candidate) => candidate.sessionId === sessionId);
  if (link === undefined) {
    return grants.unconfirmed.includes(sessionId) ? (
      <p className="text-xs text-muted-foreground">
        A linked environment from before message permissions? Send one message from it, or link it
        again, to choose whether it may message threads here.
      </p>
    ) : null;
  }
  return (
    <label className="flex items-start gap-2 pt-1">
      <Switch
        checked={link.granted}
        disabled={!canSet || saving}
        aria-label="May send messages to your threads"
        onCheckedChange={(checked) => {
          setSaving(true);
          void setGrant({ environmentId, input: { sessionId, granted: Boolean(checked) } }).finally(
            () => setSaving(false),
          );
        }}
      />
      <span className="space-y-0.5">
        <span className="block text-xs font-medium text-foreground">
          May send messages to your threads
        </span>
        <span className="block text-xs text-muted-foreground">
          Lets agents on this linked machine send messages to any thread here. A message can start
          an idle thread, which then acts with that thread's own permissions.
        </span>
      </span>
    </label>
  );
});
