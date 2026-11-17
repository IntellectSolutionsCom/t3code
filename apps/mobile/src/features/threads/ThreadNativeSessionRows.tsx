import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useNativeSession } from "../../state/nativeSessions";
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
  if (session === null) return null;
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
    </View>
  );
}
