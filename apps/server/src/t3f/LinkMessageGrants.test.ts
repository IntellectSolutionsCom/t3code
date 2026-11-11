import { assert, it } from "@effect/vitest";
import {
  type AuthClientSession,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkMessageGrants from "./LinkMessageGrants.ts";

const session = (
  id: string,
  subject: string,
  scopes: AuthClientSession["scopes"],
  issuedAt = 0,
): AuthClientSession => ({
  sessionId: AuthSessionId.make(id),
  subject,
  scopes,
  method: subject === "mcp-client" ? "bearer-access-token" : "browser-session-cookie",
  client: { deviceType: subject === "mcp-client" ? "bot" : "desktop" },
  issuedAt: DateTime.makeUnsafe(issuedAt),
  expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0, 1)),
  lastConnectedAt: null,
  connected: false,
  current: false,
});

const active = [
  session("read-link", "mcp-client", mcpClientScopes("read-only")),
  session("auto-link", "mcp-client", mcpClientScopes("auto")),
  session("full-link", "mcp-client", mcpClientScopes("full-access")),
  session("old-link", "mcp-client", mcpClientScopes("read-only")),
  // Issued after links began to be recorded, and never seen to be one: an outside agent.
  session("outside-agent", "mcp-client", mcpClientScopes("read-only"), Date.UTC(2099, 0, 1)),
  session("browser", "browser", [AuthOrchestrationReadScope, AuthSettingsWriteScope]),
];

const layer = LinkMessageGrants.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({ listSessions: () => Effect.succeed(active) }),
  ),
);

/** Every row of every table that is not ours: all an official client's payloads come from these. */
const upstreamState = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) =>
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 't3f\\_%' ESCAPE '\\' ORDER BY name
      `;
      return yield* Effect.forEach(tables, ({ name }) =>
        sql.unsafe(`SELECT * FROM "${name}"`).pipe(Effect.map((rows) => [name, rows] as const)),
      );
    }),
  ),
);

it.layer(layer)("link message grants", (it) => {
  it.effect("list links below full access, grant only those, and prune grants on writes", () =>
    Effect.gen(function* () {
      const grants = yield* LinkMessageGrants.LinkMessageGrants;
      const sql = yield* SqlClient.SqlClient;
      const by = AuthSessionId.make("browser");

      for (const id of ["read-link", "auto-link", "full-link", "revoked-link"]) {
        yield* grants.recordLink(id);
      }
      yield* grants.recordLink("read-link");
      yield* sql`
        INSERT INTO t3f_link_message_grants (session_id, granted_at, granted_by_session_id)
        VALUES ('revoked-link', '2026-11-11T00:00:00.000Z', 'browser')
      `;

      assert.deepEqual(yield* grants.list, {
        links: [
          { sessionId: AuthSessionId.make("read-link"), granted: false },
          { sessionId: AuthSessionId.make("auto-link"), granted: false },
        ],
        unconfirmed: [AuthSessionId.make("old-link")],
      });
      const rows = (table: string) =>
        sql<{ readonly session_id: string }>`SELECT session_id FROM ${sql(table)} ORDER BY 1`.pipe(
          Effect.map((found) => found.map((row) => row.session_id)),
        );
      // Reading leaves revoked sessions' rows alone; the next write removes their grants.
      assert.deepEqual(yield* rows("t3f_link_sessions"), [
        "auto-link",
        "full-link",
        "read-link",
        "revoked-link",
      ]);
      assert.deepEqual(yield* rows("t3f_link_message_grants"), ["revoked-link"]);

      for (const id of ["full-link", "old-link", "outside-agent", "browser", "revoked-link"]) {
        const refused = yield* grants
          .set({ sessionId: AuthSessionId.make(id), granted: true }, by)
          .pipe(Effect.flip);
        assert.equal(refused.reason, "not_a_link", id);
      }

      const before = yield* upstreamState;
      const readLink = AuthSessionId.make("read-link");
      assert.deepEqual(yield* grants.set({ sessionId: readLink, granted: true }, by), {
        granted: true,
      });
      assert.isTrue(yield* grants.isGranted("read-link"));
      assert.deepEqual(yield* rows("t3f_link_sessions"), [
        "auto-link",
        "full-link",
        "read-link",
        "revoked-link",
      ]);
      assert.deepEqual(yield* rows("t3f_link_message_grants"), ["read-link"]);
      assert.deepEqual((yield* grants.list).links[0], { sessionId: readLink, granted: true });
      assert.deepEqual(yield* upstreamState, before);

      yield* grants.set({ sessionId: readLink, granted: false }, by);
      assert.isFalse(yield* grants.isGranted("read-link"));
      assert.deepEqual(yield* upstreamState, before);
    }),
  );
});
