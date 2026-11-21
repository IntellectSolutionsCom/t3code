import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type ScopedThreadRef, T3fThreadBadgeError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useMessages } from "gt-react";
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
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { PROJECT_EMOJIS } from "~/projectIconOptions";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadBadges, threadSettingsThreadAtom, useThreadBadge } from "./threadBadges";

const isThreadBadgeError = Schema.is(T3fThreadBadgeError);

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
  const m = useMessages();
  const current = useThreadBadge(threadRef);
  const canSet = useAtomValue(threadBadges.set.permissionAtom(threadRef.environmentId));
  const setBadge = useAtomCommand(threadBadges.set, { reportFailure: false });
  const [symbol, setSymbol] = useState(current?.symbol ?? "");
  const [label, setLabel] = useState(current?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{
    readonly field: "symbol" | "label" | null;
    readonly message: string;
  } | null>(null);
  const trimmedSymbol = symbol.trim();

  const changeSymbol = (value: string) => {
    setSymbol(value);
    setFailure(null);
  };
  const changeLabel = (value: string) => {
    setLabel(value);
    setFailure(null);
  };

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
    setFailure(
      isThreadBadgeError(error)
        ? {
            field:
              error.reason === "invalid_label"
                ? "label"
                : error.reason === "invalid_symbol"
                  ? "symbol"
                  : null,
            message: error.message,
          }
        : {
            field: null,
            message: error instanceof Error ? error.message : "Could not save the badge.",
          },
    );
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
              if (!trimmedSymbol) {
                setFailure({
                  field: "symbol",
                  message: "Choose a symbol above, or type or paste one emoji.",
                });
                return;
              }
              void save({ symbol: trimmedSymbol, label });
            }}
          >
            <div className="grid gap-1.5">
              <Label id="thread-badge-symbol-label" htmlFor="thread-badge-symbol">
                Symbol
              </Label>
              <ScrollArea scrollFade className="max-h-64">
                <div
                  role="group"
                  aria-labelledby="thread-badge-symbol-label"
                  className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10"
                >
                  {PROJECT_EMOJIS.map((option) => {
                    const selected = trimmedSymbol === option.emoji;
                    return (
                      <button
                        key={option.emoji}
                        type="button"
                        aria-label={m(option.label)}
                        aria-pressed={selected}
                        className={cn(
                          "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          selected && "border-border bg-accent",
                        )}
                        onClick={() => changeSymbol(option.emoji)}
                      >
                        {option.emoji}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
              <Input
                id="thread-badge-symbol"
                autoFocus
                value={symbol}
                placeholder="Type or paste an emoji"
                aria-invalid={failure?.field === "symbol" || undefined}
                onChange={(event) => changeSymbol(event.currentTarget.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="thread-badge-label">Label</Label>
              <Input
                id="thread-badge-label"
                value={label}
                placeholder="Up to 24 characters"
                aria-invalid={failure?.field === "label" || undefined}
                onChange={(event) => changeLabel(event.currentTarget.value)}
              />
            </div>
            {failure !== null ? (
              <p role="alert" className="text-destructive text-xs">
                {failure.message}
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
