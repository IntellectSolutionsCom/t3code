import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadBadges, threadSettingsThreadAtom, useThreadBadge } from "./threadBadges";

export function ThreadSettingsDialogHost() {
  const threadRef = useAtomValue(threadSettingsThreadAtom);
  if (threadRef === null) return null;
  return (
    <ThreadSettingsDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(threadSettingsThreadAtom, null)}
    />
  );
}

function ThreadSettingsDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const current = useThreadBadge(threadRef);
  const canSet = useAtomValue(threadBadges.set.permissionAtom(threadRef.environmentId));
  const setBadge = useAtomCommand(threadBadges.set, { reportFailure: false });
  const [symbol, setSymbol] = useState(current?.symbol ?? "");
  const [label, setLabel] = useState(current?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async (badge: { symbol: string; label: string } | null) => {
    setSaving(true);
    setFailure(null);
    const result = await setBadge({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, badge },
    });
    setSaving(false);
    if (result._tag === "Success") return onClose();
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : "Could not save the badge.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Thread settings</DialogTitle>
          <DialogDescription>
            A badge puts one emoji and a short label beside the thread&apos;s title.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="thread-settings-form"
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ symbol: symbol.trim(), label });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="thread-badge-symbol">Symbol</Label>
              <Input
                id="thread-badge-symbol"
                autoFocus
                value={symbol}
                placeholder="🚀"
                aria-invalid={failure !== null || undefined}
                onChange={(event) => setSymbol(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="thread-badge-label">Label</Label>
              <Input
                id="thread-badge-label"
                value={label}
                placeholder="Launch"
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {failure !== null ? (
              <p role="alert" className="text-destructive text-xs">
                {failure}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          {current !== null ? (
            <Button
              variant="outline"
              size="sm"
              className="mr-auto"
              disabled={!canSet || saving}
              onClick={() => void save(null)}
            >
              Clear badge
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form="thread-settings-form" disabled={!canSet || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
