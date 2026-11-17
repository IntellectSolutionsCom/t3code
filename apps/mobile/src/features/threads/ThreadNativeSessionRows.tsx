import { useAtomValue } from "@effect/atom-react";
import { handOutRefusedDescription } from "@t3tools/client-runtime/state/nativeSessions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  nativeSessionEnvironment,
  useCanHandOut,
  useHandOutBlocker,
  useNativeSession,
  useTakeBack,
} from "../../state/nativeSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { CopyTextButton } from "./CopyTextButton";

/** The thread a settings sheet belongs to; a new task has none. */
export const NativeSessionThread = createContext<ScopedThreadRef | null>(null);

/** The provider's own session behind the thread. Hidden until the provider opens one. */
export function ThreadNativeSessionRows() {
  const thread = useContext(NativeSessionThread);
  const session = useNativeSession(thread);
  const environmentLabel = useSavedRemoteConnection(
    thread?.environmentId ?? null,
  )?.environmentLabel;
  const takeBack = useTakeBack(thread);
  const supportsHandOut = useCanHandOut(thread?.environmentId ?? null);
  const mayHandOut = useAtomValue(
    nativeSessionEnvironment.handOut.permissionAtom(thread?.environmentId ?? null),
  );
  const handOut = useAtomCommand(
    nativeSessionEnvironment.handOut,
    "Could not hand the session out",
  );
  const handOutBlocker = useHandOutBlocker(thread);
  if (thread === null || session === null) return null;
  const { command } = session;
  const continueInTerminal = async (text: string) => {
    await tryCopyTextWithHaptic(text);
    const result = await handOut({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Not handed out",
        handOutRefusedDescription(error instanceof Error ? error.message : String(error)),
      );
    }
  };
  const handOutAction =
    !supportsHandOut || !mayHandOut ? null : takeBack !== null ? (
      <Button label="Take back" tone="text" onPress={() => void takeBack.takeBack()} />
    ) : command !== null ? (
      <Button
        label="Continue in terminal"
        tone="text"
        accessibilityLabel="Copy the command and continue in terminal"
        disabled={handOutBlocker !== null}
        onPress={() => void continueInTerminal(command)}
      />
    ) : null;
  const rows: ReadonlyArray<{ label: string; caption?: string; value: string }> = [
    { label: "Session id", value: session.nativeId },
    ...(session.name !== null ? [{ label: "Session name", value: session.name }] : []),
    ...(session.command !== null
      ? [
          {
            label: "Command",
            ...(environmentLabel ? { caption: `Command · run on ${environmentLabel}` } : {}),
            value: session.command,
          },
        ]
      : []),
  ];

  return (
    <View>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        Native session
      </Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        {rows.map((row, index) => (
          <View
            key={row.label}
            className={cn(
              "flex-row items-center gap-3 px-4 py-2.5",
              index < rows.length - 1 && "border-b border-border-subtle",
            )}
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="font-mono text-sm text-foreground" selectable>
                {row.value}
              </Text>
              <Text className="text-xs text-foreground-muted">{row.caption ?? row.label}</Text>
            </View>
            <CopyTextButton
              accessibilityLabel={`Copy ${row.label.toLowerCase()}`}
              text={row.value}
            />
          </View>
        ))}
      </View>
      {session.command === null && session.commandNote !== null ? (
        <Text className="px-5 pt-2 text-xs text-foreground-muted">{session.commandNote}</Text>
      ) : null}
      {handOutAction !== null ? (
        <View className="flex-row items-center justify-end gap-2 px-4 pt-1">
          {takeBack === null && handOutBlocker !== null ? (
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted">{handOutBlocker}</Text>
          ) : null}
          {handOutAction}
        </View>
      ) : null}
    </View>
  );
}
