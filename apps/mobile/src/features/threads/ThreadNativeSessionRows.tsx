import { useAtomValue } from "@effect/atom-react";
import {
  handOutRefusedDescription,
  nativeSessionCommandAction,
} from "@t3tools/client-runtime/state/nativeSessions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react-native";
import { createContext, useContext } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
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
  const gt = useGT();
  const thread = useContext(NativeSessionThread);
  const session = useNativeSession(thread);
  const environment =
    useSavedRemoteConnection(thread?.environmentId ?? null)?.environmentLabel ?? null;
  const takeBack = useTakeBack(thread);
  const supportsHandOut = useCanHandOut(thread?.environmentId ?? null);
  const mayHandOut = useAtomValue(
    nativeSessionEnvironment.handOut.permissionAtom(thread?.environmentId ?? null),
  );
  const handOut = useAtomCommand(
    nativeSessionEnvironment.handOut,
    gt("Could not move the session to the terminal"),
  );
  const handOutBlocker = useHandOutBlocker(thread);
  if (thread === null || session === null) return null;
  const { nativeId, command, commandNote } = session;
  const commandAction = nativeSessionCommandAction(
    supportsHandOut && mayHandOut,
    takeBack !== null,
  );
  const moveToTerminal = async (text: string) => {
    await tryCopyTextWithHaptic(text);
    const result = await handOut({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        m(msg("Not moved to the terminal")),
        handOutRefusedDescription(error instanceof Error ? error.message : String(error), m),
      );
    }
  };
  const copyCommand =
    command === null ? null : (
      <Button
        label={gt("Copy command")}
        tone="text"
        onPress={async () => {
          if (!(await tryCopyTextWithHaptic(command))) {
            Dialog.alert(m(msg("Could not copy")), m(msg("Try again.")));
          }
        }}
      />
    );

  return (
    <View>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        <T>Native session</T>
      </Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        <View className="flex-row items-center gap-3 px-4 py-2.5">
          <Text className="min-w-0 flex-1 text-sm text-foreground">{gt("Copy session id")}</Text>
          <CopyTextButton accessibilityLabel={gt("Copy session id")} text={nativeId} />
        </View>
      </View>
      {command === null && commandNote !== null ? (
        <Text className="px-5 pt-2 text-xs text-foreground-muted">{commandNote}</Text>
      ) : null}
      {takeBack !== null ? (
        <View className="gap-1 px-5 pt-2">
          <Text className="text-xs text-foreground-muted">
            <T>In terminal · paused here</T>
          </Text>
          <View className="flex-row flex-wrap items-center gap-2">
            {copyCommand}
            {mayHandOut ? (
              <Button
                label={gt("Move back")}
                tone="text"
                onPress={() => void takeBack.takeBack()}
              />
            ) : null}
          </View>
        </View>
      ) : command === null ? null : (
        <View className="items-start gap-1 px-5 pt-2">
          {commandAction === "copy" ? (
            copyCommand
          ) : (
            <>
              <Button
                label={gt("Move to terminal")}
                tone="text"
                disabled={handOutBlocker !== null}
                onPress={() => void moveToTerminal(command)}
              />
              <Text className="text-xs text-foreground-muted">
                {environment === null ? (
                  <T>Pauses this thread here and copies the command</T>
                ) : (
                  <T>
                    Pauses this thread here and copies the command to run on{" "}
                    <Var>{environment}</Var>
                  </T>
                )}
              </Text>
              {handOutBlocker !== null ? (
                <Text className="text-xs text-foreground-muted">{handOutBlocker}</Text>
              ) : null}
            </>
          )}
        </View>
      )}
    </View>
  );
}
