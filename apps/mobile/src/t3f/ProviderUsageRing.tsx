import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import { pickerUsage, pickerUsageLines } from "@t3tools/shared/picker-usage";
import { useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../components/ui/AppText";
import { useNowMinuteMs } from "../lib/clock";
import { environmentServerConfigsAtom } from "../state/server";

const ThemedSvg = withUniwind(Svg);
const STROKE = 1.5;

const usageOf = (provider: ServerProvider | undefined, model: string | undefined, now: number) =>
  provider && model
    ? pickerUsage({ driver: provider.driver, limits: provider.usageLimits, model, now })
    : null;

/** Rings the composer pill's provider icon with what is left of the selected model's week. */
export function ProviderUsageRing(props: {
  readonly provider: ServerProvider | undefined;
  readonly model: string | undefined;
  readonly size: number;
  readonly children: ReactNode;
}) {
  const usage = usageOf(props.provider, props.model, useNowMinuteMs());
  if (!usage) return props.children;
  const box = props.size + 4;
  const r = (box - STROKE) / 2;
  const length = 2 * Math.PI * r;
  const circle = { cx: box / 2, cy: box / 2, r, fill: "none", stroke: "currentColor" };
  return (
    <View style={{ width: props.size, height: props.size, overflow: "visible" }}>
      {props.children}
      <ThemedSvg
        pointerEvents="none"
        width={box}
        height={box}
        colorClassName={usage.warn ? "accent-warning-foreground" : "accent-foreground"}
        style={{ position: "absolute", left: -2, top: -2, transform: [{ rotate: "-90deg" }] }}
      >
        <Circle {...circle} strokeWidth={STROKE} strokeOpacity={0.12} />
        <Circle
          {...circle}
          strokeWidth={STROKE}
          strokeOpacity={0.85}
          strokeDasharray={[(length * usage.weekly.left) / 100, length]}
        />
      </ThemedSvg>
    </View>
  );
}

/** The web tooltip's lines, shown under the selected model in the model sheet. */
export function ProviderUsageLines(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection;
}) {
  const m = useMessages();
  const now = useNowMinuteMs();
  const providers = useAtomValue(environmentServerConfigsAtom).get(props.environmentId)?.providers;
  const provider = providers?.find((entry) => entry.instanceId === props.selection.instanceId);
  const usage = usageOf(provider, props.selection.model, now);
  if (!usage) return null;
  return (
    <Text className="text-xs text-foreground-muted">
      {pickerUsageLines(usage, now, m).join("\n")}
    </Text>
  );
}
