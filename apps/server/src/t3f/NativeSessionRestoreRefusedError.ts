import { ProviderAdapterRollbackThreadError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

export const crossedTakeBackMessage = (action: "restore" | "fork") =>
  `This point is before this thread's session was last used in the terminal. ${action === "restore" ? "Restoring" : "Forking"} here could keep turns this thread doesn't show. Fork from a later turn or start a new thread.`;

export class NativeSessionRestoreRefusedError extends ProviderAdapterRollbackThreadError {
  override get message(): string {
    return crossedTakeBackMessage("restore");
  }
}

// The subclass shares the adapter error's schema, so distinguish it by class.
export const isNativeSessionRestoreRefusedError = Schema.is(
  Schema.instanceOf(NativeSessionRestoreRefusedError),
);
