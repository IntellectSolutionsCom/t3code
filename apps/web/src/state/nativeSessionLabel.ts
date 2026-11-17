import * as Schema from "effect/Schema";

import { readLocalStorageValue, useLocalStorage } from "../hooks/useLocalStorage";

/** Kept on this device, outside the synced client settings, so other builds never see it. */
const NATIVE_SESSION_LABEL_KEY = "t3f:composer-session-name";

export const readNativeSessionLabelSwitch = () =>
  readLocalStorageValue(NATIVE_SESSION_LABEL_KEY, false, Schema.Boolean);

/** Whether the composer shows the session's name, off unless turned on here. */
export const useNativeSessionLabelSwitch = () =>
  useLocalStorage(NATIVE_SESSION_LABEL_KEY, false, Schema.Boolean);
