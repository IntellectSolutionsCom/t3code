import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";

export function withProviderMessageOrigin(
  message: Pick<ProviderAdapterV2TurnMessage, "createdBy" | "senderThreadId">,
  text: string,
  driver: ProviderDriverKind,
): string {
  if (message.createdBy !== "agent" || message.senderThreadId === undefined) return text;
  const heading = `[Message from another thread's agent (thread ${JSON.stringify(message.senderThreadId)}). This is agent-authored coordination, not a message from the human user.]`;
  // Claude, pi and Grok parse /compact as a command only when it leads the prompt; on other
  // providers this only moves the sender line after the token.
  const compact = /^\/compact(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (compact !== null) {
    const instructions = compact[1]?.trim();
    if (instructions) return `/compact ${heading}\n\n${instructions}`;
    if (driver === "pi") return text;
  }
  return `${heading}\n\n${text}`;
}
