import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useTakeBack } from "../../state/nativeSessions";
import { formatMessageTimestamp } from "./messageTimestamp";

/** While the thread is out in its provider's own client, the composer says so. */
export function NativeSessionOutBanner(props: { readonly threadRef: ScopedThreadRef | null }) {
  const gt = useGT();
  const takeBack = useTakeBack(props.threadRef);
  if (takeBack === null) return null;
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="terminal" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {gt("In terminal · paused here since {time}", {
          time: formatMessageTimestamp(takeBack.out.since),
        })}
      </Text>
      <Button label={gt("Move back")} tone="text" onPress={() => void takeBack.takeBack()} />
    </View>
  );
}
