import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";
import { ProviderAdapterRollbackThreadError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

export const crossedTakeBackMessage = (driver: ProviderDriverKind, action: "restore" | "fork") =>
  `This point is before the thread was taken back from ${PROVIDER_DISPLAY_NAMES[driver] ?? driver}'s own client. ${action === "restore" ? "Restoring" : "Forking"} here could keep turns this thread doesn't show. Fork from a turn made after the take-back or start a new thread.`;

export class NativeSessionRestoreRefusedError extends ProviderAdapterRollbackThreadError {
  override get message(): string {
    return crossedTakeBackMessage(this.driver, "restore");
  }
}

// The subclass shares the adapter error's schema, so distinguish it by class.
export const isNativeSessionRestoreRefusedError = Schema.is(
  Schema.instanceOf(NativeSessionRestoreRefusedError),
);
