import { useNativeSessionLabelSwitch } from "../../state/nativeSessionLabel";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function NativeSessionLabelSettings() {
  const [shown, setShown] = useNativeSessionLabelSwitch();
  return (
    <SettingsSection title="Native session">
      <SettingsRow
        {...searchableSetting("native-session-label")}
        description="The name the provider's own client gives the thread's session. Saved on this device."
        devicePreference
        resetAction={
          shown ? (
            <SettingResetButton label="session name label" onClick={() => setShown(false)} />
          ) : null
        }
        control={
          <Switch
            checked={shown}
            onCheckedChange={(checked) => setShown(Boolean(checked))}
            aria-label="Show the session name above the composer"
          />
        }
      />
    </SettingsSection>
  );
}
