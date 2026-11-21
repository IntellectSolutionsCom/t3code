import { createMemoryHistory } from "@tanstack/react-router";
import { ProviderDriverKind, T3F_NATIVE_SESSION_WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see the handoff test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("takes an out thread back before sending to it", async () => {
  const thread = threadWithHistory("thread-out", 2);
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  using _out = answerRpc(T3F_NATIVE_SESSION_WS_METHODS.subscribeOut, () =>
    Stream.make({
      threads: [
        {
          threadId: thread.id,
          driver: ProviderDriverKind.make("codex"),
          since: "2026-03-17T19:12:28.000Z",
        },
      ],
    }).pipe(Stream.concat(Stream.never)),
  );
  const messages = () =>
    dispatchedCommands().flatMap((command) =>
      command.type === "message.dispatch" ? [command.text] : [],
    );
  const takenBack: Array<{ readonly threadId: string; readonly sentBefore: number }> = [];
  using _takeBack = answerRpc(
    T3F_NATIVE_SESSION_WS_METHODS.takeBack,
    (input: { readonly threadId: string }) =>
      Effect.sync(() => {
        takenBack.push({ threadId: input.threadId, sentBefore: messages().length });
        return {};
      }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect
    .element(page.getByText("In terminal · paused here since", { exact: false }))
    .toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.type(editor, "carry on");
  await page.getByRole("button", { name: "Move back and send" }).click();

  await vi.waitFor(() => expect(messages()).toEqual(["carry on"]));
  expect(takenBack).toEqual([{ threadId: thread.id, sentBefore: 0 }]);
});
