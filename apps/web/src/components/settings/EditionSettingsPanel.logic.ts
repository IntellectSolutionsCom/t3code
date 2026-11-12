import { type AuthClientSession, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { LinkMessageGrants } from "@t3tools/client-runtime/state/linkMessageGrants";

export interface LinkMessageRow {
  readonly sessionId: AuthClientSession["sessionId"];
  readonly label: string;
  /** The scopes cannot tell the levels between read only and full access apart. */
  readonly level: "Read only" | "Below full access";
  readonly status: string;
  readonly granted: boolean;
}

export type LinkMessagesState =
  | { readonly kind: "unreachable" }
  | { readonly kind: "no-read-scope" }
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "links";
      readonly rows: ReadonlyArray<LinkMessageRow>;
      readonly unconfirmed: boolean;
    };

// Named as Authorized clients names the same session.
function linkSessionLabel({ client, subject }: AuthClientSession): string {
  return client.label ?? ([client.os, client.browser].filter(Boolean).join(" · ") || subject);
}

export function linkMessagesState(input: {
  /** Unknown until the session loads; unreachable when the machine is offline or its session failed. */
  readonly readAccess: "unknown" | "unreachable" | "denied" | "granted";
  readonly grants: { readonly data: LinkMessageGrants | null; readonly error: string | null };
  readonly sessions: {
    readonly data: ReadonlyArray<AuthClientSession> | null;
    readonly error: string | null;
  };
}): LinkMessagesState {
  const { grants, sessions } = input;
  if (input.readAccess === "unreachable") return { kind: "unreachable" };
  if (input.readAccess === "denied") return { kind: "no-read-scope" };
  if (grants.data?.supported === false) return { kind: "unsupported" };
  const error = grants.error ?? sessions.error;
  if (error !== null) return { kind: "error", message: error };
  if (input.readAccess === "unknown" || grants.data === null || sessions.data === null) {
    return { kind: "loading" };
  }
  const sessionsById = new Map(sessions.data.map((session) => [session.sessionId, session]));
  return {
    kind: "links",
    rows: grants.data.links.flatMap((link) => {
      const session = sessionsById.get(link.sessionId);
      if (session === undefined) return [];
      const operates = (session.permissions ?? session.scopes).includes(
        AuthOrchestrationOperateScope,
      );
      return [
        {
          sessionId: link.sessionId,
          label: linkSessionLabel(session),
          level: operates ? "Below full access" : "Read only",
          status: link.granted
            ? "May message any thread here"
            : operates
              ? "Only threads it started"
              : "Cannot send messages",
          granted: link.granted,
        },
      ];
    }),
    unconfirmed: grants.data.unconfirmed.length > 0,
  };
}

/** Changes when a session is issued or revoked, so a new link's grant can be fetched. */
export function sessionSetKey(sessions: ReadonlyArray<AuthClientSession> | null): string | null {
  return sessions === null
    ? null
    : sessions
        .map((session) => session.sessionId)
        .toSorted()
        .join(",");
}
