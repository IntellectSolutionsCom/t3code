import { RegistryContext } from "@effect/atom-react";
import {
  type AuthAccessStreamSnapshotEvent,
  type AuthClientSession,
  AuthSessionId,
  EnvironmentId,
  type T3fLinkMessageGrant,
} from "@t3tools/contracts";
import type { LinkMessageGrants } from "@t3tools/client-runtime/state/linkMessageGrants";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { LinkMessagesSettings } from "./EditionSettingsPanel";

type AccessResult = AsyncResult.AsyncResult<AuthAccessStreamSnapshotEvent, never>;

const state = vi.hoisted(() => ({
  grants: null as unknown,
  access: null as unknown,
}));

vi.mock(import("../../state/linkMessageGrants"), () => ({
  linkMessageGrantEnvironment: {
    list: () => state.grants,
    set: { permissionAtom: () => Atom.make(true) },
  } as never,
}));
vi.mock(import("../../state/auth"), async (original) => ({
  ...(await original()),
  authEnvironment: { accessChanges: () => state.access } as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  useEnvironmentSessionState: (() => ({ data: {}, hasError: false, isPending: false })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

const environmentId = EnvironmentId.make("environment");
const browserId = AuthSessionId.make("browser");
const linkId = AuthSessionId.make("link");

const session = (sessionId: AuthSessionId, label: string): AuthClientSession => ({
  sessionId,
  subject: sessionId,
  scopes: ["orchestration:read"],
  method: "bearer-access-token",
  client: { label, deviceType: "bot" },
  issuedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(0),
  lastConnectedAt: null,
  connected: true,
  current: false,
});
const snapshot = (clientSessions: ReadonlyArray<AuthClientSession>): AccessResult =>
  AsyncResult.success({
    version: 1,
    revision: clientSessions.length,
    type: "snapshot",
    payload: { pairingLinks: [], clientSessions },
  });

function setup() {
  const server = { links: [] as Array<T3fLinkMessageGrant> };
  state.grants = Atom.make(() =>
    AsyncResult.success<LinkMessageGrants>({
      supported: true,
      links: [...server.links],
      unconfirmed: [],
    }),
  );
  const access = Atom.make<AccessResult>(snapshot([session(browserId, "Browser")]));
  state.access = access;
  return { server, access };
}

it("lists a link made while the page is open", async () => {
  const { server, access } = setup();
  const registry = AtomRegistry.make();
  try {
    await using screen = await render(
      <RegistryContext value={registry}>
        <LinkMessagesSettings environmentId={environmentId} />
      </RegistryContext>,
    );
    await expect
      .element(screen.getByText("No machine is linked here below full access"))
      .toBeVisible();

    server.links.push({ sessionId: linkId, granted: false });
    registry.set(
      access,
      snapshot([session(browserId, "Browser"), session(linkId, "T3 Code · alpha")]),
    );

    await expect.element(screen.getByText("T3 Code · alpha")).toBeVisible();
    await expect.element(screen.getByText("Read only · Cannot send messages")).toBeVisible();
  } finally {
    registry.dispose();
  }
});
