import {
  type AuthSessionId,
  AuthSettingsWriteScope,
  T3fLinkMessageGrantError,
  type T3fLinkMessageGrantSetInput,
  type T3fLinkMessageGrantsListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

/** The subject EnvironmentAuth issues agent sessions under, links included. */
const MCP_CLIENT_SUBJECT = "mcp-client";

export class LinkMessageGrants extends Context.Service<
  LinkMessageGrants,
  {
    /** Whether a link session may send messages to threads here. Fails closed. */
    readonly isGranted: (sessionId: string) => Effect.Effect<boolean>;
    /** Notes that a session is another environment's link; only its token says so. */
    readonly recordLink: (sessionId: string) => Effect.Effect<void>;
    /** Link sessions below full access, and agent sessions from before links were recorded. */
    readonly list: Effect.Effect<T3fLinkMessageGrantsListResult, T3fLinkMessageGrantError>;
    readonly set: (
      input: T3fLinkMessageGrantSetInput,
      grantedBy: AuthSessionId,
    ) => Effect.Effect<{ readonly granted: boolean }, T3fLinkMessageGrantError>;
  }
>()("t3/t3f/LinkMessageGrants") {}

const storageError = (cause: unknown) =>
  Effect.logWarning("Link message grants could not be read or written.", { cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new T3fLinkMessageGrantError({
          reason: "storage",
          message: "Message permissions for links could not be read or saved.",
        }),
      ),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const recorded = yield* Ref.make<ReadonlySet<string>>(new Set());

  const isGranted: LinkMessageGrants["Service"]["isGranted"] = Effect.fn(
    "LinkMessageGrants.isGranted",
  )(function* (sessionId) {
    const rows = yield* sql`
      SELECT 1 FROM t3f_link_message_grants WHERE session_id = ${sessionId}
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read a link's message grant.", { cause }).pipe(Effect.as([])),
      ),
    );
    return rows.length > 0;
  });

  const recordLink: LinkMessageGrants["Service"]["recordLink"] = Effect.fn(
    "LinkMessageGrants.recordLink",
  )(function* (sessionId) {
    if ((yield* Ref.get(recorded)).has(sessionId)) return;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO t3f_link_sessions (session_id, recorded_at) VALUES (${sessionId}, ${now})
      ON CONFLICT (session_id) DO NOTHING
    `.pipe(
      Effect.andThen(Ref.update(recorded, (current) => new Set([...current, sessionId]))),
      Effect.catch((cause) => Effect.logWarning("Could not record a link session.", { cause })),
    );
  });

  const readEligible = Effect.gen(function* () {
    const active = yield* environmentAuth.listSessions().pipe(Effect.catch(storageError));
    const agents = active.filter(
      (session) =>
        session.subject === MCP_CLIENT_SUBJECT && !session.scopes.includes(AuthSettingsWriteScope),
    );
    const links = new Set(
      (yield* sql<{ readonly session_id: string }>`SELECT session_id FROM t3f_link_sessions`.pipe(
        Effect.catch(storageError),
      )).map((row) => row.session_id),
    );
    return { active, agents, links };
  });

  // Links issued since our first migration were recorded at token exchange; only older ones can be unknown.
  const recordingSince = sql<{ readonly since: string }>`
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS since
    FROM t3f_migrations WHERE migration_id = 1
  `.pipe(
    Effect.catch(storageError),
    Effect.map(([row]) => (row === undefined ? undefined : DateTime.makeUnsafe(row.since))),
  );

  const list: LinkMessageGrants["Service"]["list"] = Effect.gen(function* () {
    const { agents, links } = yield* readEligible;
    const since = yield* recordingSince;
    const granted = new Set(
      (yield* sql<{
        readonly session_id: string;
      }>`SELECT session_id FROM t3f_link_message_grants`.pipe(Effect.catch(storageError))).map(
        (row) => row.session_id,
      ),
    );
    return {
      links: agents
        .filter((session) => links.has(session.sessionId))
        .map((session) => ({
          sessionId: session.sessionId,
          granted: granted.has(session.sessionId),
        })),
      unconfirmed: agents
        .filter(
          (session) =>
            !links.has(session.sessionId) &&
            since !== undefined &&
            DateTime.isLessThan(session.issuedAt, since),
        )
        .map((session) => session.sessionId),
    };
  }).pipe(Effect.withSpan("LinkMessageGrants.list"));

  const set: LinkMessageGrants["Service"]["set"] = Effect.fn("LinkMessageGrants.set")(function* (
    { sessionId, granted },
    grantedBy,
  ) {
    const { active, agents, links } = yield* readEligible;
    if (!links.has(sessionId) || !agents.some((session) => session.sessionId === sessionId)) {
      return yield* new T3fLinkMessageGrantError({
        reason: "not_a_link",
        message: "Only an active linked environment below full access can be allowed this.",
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const activeIds = active.map((session) => session.sessionId);
    // Grants of revoked or expired sessions are removed on this rare write. Recorded links are kept:
    // a link paired after the session snapshot above would otherwise lose its row.
    yield* sql
      .withTransaction(
        Effect.all([
          sql`DELETE FROM t3f_link_message_grants WHERE NOT ${sql.in("session_id", activeIds)}`,
          granted
            ? sql`
                INSERT INTO t3f_link_message_grants (session_id, granted_at, granted_by_session_id)
                VALUES (${sessionId}, ${now}, ${grantedBy})
                ON CONFLICT (session_id) DO NOTHING
              `
            : sql`DELETE FROM t3f_link_message_grants WHERE session_id = ${sessionId}`,
        ]),
      )
      .pipe(Effect.catch(storageError));
    return { granted };
  });

  return LinkMessageGrants.of({ isGranted, recordLink, list, set });
});

export const layer = Layer.effect(LinkMessageGrants, make);
