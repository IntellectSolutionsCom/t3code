import { type AuthClientSession, AuthSessionId } from "@t3tools/contracts";
import type { LinkMessageGrants } from "@t3tools/client-runtime/state/linkMessageGrants";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { linkMessagesState } from "./EditionSettingsPanel.logic";

const readOnlyId = AuthSessionId.make("read-only-link");
const operateId = AuthSessionId.make("operate-link");
const revokedId = AuthSessionId.make("revoked-link");
const legacyId = AuthSessionId.make("legacy-agent");

const session = (
  sessionId: AuthSessionId,
  label: string,
  scopes: AuthClientSession["scopes"],
): AuthClientSession => ({
  sessionId,
  subject: `subject-${sessionId}`,
  scopes,
  method: "bearer-access-token",
  client: { label, deviceType: "bot" },
  issuedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(0),
  lastConnectedAt: null,
  connected: true,
  current: false,
});

const sessions = [
  session(readOnlyId, "T3 Code · alpha", ["orchestration:read"]),
  session(operateId, "T3 Code · beta", ["orchestration:read", "orchestration:operate"]),
];
const grants = (
  links: ReadonlyArray<readonly [AuthSessionId, boolean]>,
  unconfirmed: ReadonlyArray<AuthSessionId> = [],
): LinkMessageGrants => ({
  supported: true,
  links: links.map(([sessionId, granted]) => ({ sessionId, granted })),
  unconfirmed,
});

describe("linkMessagesState", () => {
  it.each([
    {
      name: "no read scope",
      readAccess: "denied",
      grants: { data: null, error: null },
      sessions: { data: null, error: null },
      expected: { kind: "no-read-scope" },
    },
    {
      name: "the session still loading, never a missing scope",
      readAccess: "unknown",
      grants: { data: null, error: null },
      sessions: { data: null, error: null },
      expected: { kind: "loading" },
    },
    {
      name: "an offline machine",
      readAccess: "unreachable",
      grants: { data: null, error: null },
      sessions: { data: null, error: null },
      expected: { kind: "unreachable" },
    },
    {
      name: "loading the grants",
      readAccess: "granted",
      grants: { data: null, error: null },
      sessions: { data: sessions, error: null },
      expected: { kind: "loading" },
    },
    {
      name: "loading the sessions",
      readAccess: "granted",
      grants: { data: grants([]), error: null },
      sessions: { data: null, error: null },
      expected: { kind: "loading" },
    },
    {
      name: "a server without grants",
      readAccess: "granted",
      grants: { data: { supported: false } as const, error: null },
      sessions: { data: null, error: "stream closed" },
      expected: { kind: "unsupported" },
    },
    {
      name: "an error, never an empty list",
      readAccess: "granted",
      grants: { data: null, error: "The environment request failed." },
      sessions: { data: sessions, error: null },
      expected: { kind: "error", message: "The environment request failed." },
    },
    {
      name: "a session stream error",
      readAccess: "granted",
      grants: { data: grants([[readOnlyId, true]]), error: null },
      sessions: { data: sessions, error: "stream closed" },
      expected: { kind: "error", message: "stream closed" },
    },
    {
      name: "no links",
      readAccess: "granted",
      grants: { data: grants([]), error: null },
      sessions: { data: sessions, error: null },
      expected: { kind: "links", rows: [], unconfirmed: false },
    },
    {
      name: "each level on and off; a link missing from the sessions is dropped",
      readAccess: "granted",
      grants: {
        data: grants([
          [readOnlyId, true],
          [operateId, true],
          [revokedId, true],
        ]),
        error: null,
      },
      sessions: { data: sessions, error: null },
      expected: {
        kind: "links",
        rows: [
          {
            sessionId: readOnlyId,
            label: "T3 Code · alpha",
            level: "Read only",
            status: "May message any thread here",
            granted: true,
          },
          {
            sessionId: operateId,
            label: "T3 Code · beta",
            level: "Below full access",
            status: "May message any thread here",
            granted: true,
          },
        ],
        unconfirmed: false,
      },
    },
    {
      name: "both levels off, with unconfirmed agents as a note",
      readAccess: "granted",
      grants: {
        data: grants(
          [
            [readOnlyId, false],
            [operateId, false],
          ],
          [legacyId],
        ),
        error: null,
      },
      sessions: { data: sessions, error: null },
      expected: {
        kind: "links",
        rows: [
          {
            sessionId: readOnlyId,
            label: "T3 Code · alpha",
            level: "Read only",
            status: "Cannot send messages",
            granted: false,
          },
          {
            sessionId: operateId,
            label: "T3 Code · beta",
            level: "Below full access",
            status: "Only threads it started",
            granted: false,
          },
        ],
        unconfirmed: true,
      },
    },
  ] as const)("$name", ({ expected, ...input }) => {
    expect(linkMessagesState(input)).toEqual(expected);
  });
});
