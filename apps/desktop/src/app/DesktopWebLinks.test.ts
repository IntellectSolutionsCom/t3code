// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron webContents.
import { assert, describe, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const makeWindow = ({ open = true } = {}) => {
  const sent: Array<string> = [];
  const revealed: Array<unknown> = [];
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, url: string) => {
      if (channel === WEB_LINK_OPEN_CHANNEL) sent.push(url);
    },
  });
  const window = { webContents } as unknown as Electron.BrowserWindow;
  let current: Electron.BrowserWindow | null = open ? window : null;
  const reload = () =>
    webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  const layer = DesktopWebLinks.layer.pipe(
    Layer.provide(
      Layer.succeed(DesktopWindow.DesktopWindow, {
        // Like activate, opens the main window when none is left.
        activate: Effect.sync(() => {
          current = window;
          revealed.push(window);
        }),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          currentMainOrFirst: Effect.sync(() => Option.fromNullishOr(current)),
          reveal: (target: Electron.BrowserWindow) => Effect.sync(() => void revealed.push(target)),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
      ),
    ),
    Layer.provide(
      Layer.succeed(ElectronApp.ElectronApp, {
        whenReady: Effect.void,
      } as unknown as ElectronApp.ElectronApp["Service"]),
    ),
  );
  return { sent, revealed, layer, reload };
};

describe("DesktopWebLinks", () => {
  it.effect("holds links until the renderer listens, then delivers them in order", () => {
    const { sent, revealed, layer } = makeWindow();
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.receive("https://example.com/first");
      yield* webLinks.receive("https://example.com/second");
      assert.deepStrictEqual(sent, []);
      assert.strictEqual(revealed.length, 2);

      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, ["https://example.com/first", "https://example.com/second"]);
      assert.strictEqual(revealed.length, 3);

      yield* webLinks.receive("https://example.com/third");
      assert.deepStrictEqual(sent.at(-1), "https://example.com/third");

      yield* webLinks.setRendererReady(false);
      yield* webLinks.receive("https://example.com/fourth");
      assert.strictEqual(sent.length, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("holds links that arrive while the web app reloads until it listens again", () => {
    const { sent, layer, reload } = makeWindow();
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.setRendererReady(true);
      reload();
      yield* webLinks.receive("https://example.com/during-reload");
      assert.deepStrictEqual(sent, []);

      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, ["https://example.com/during-reload"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens a window for a link that arrives with none, and delivers it there", () => {
    const { sent, revealed, layer } = makeWindow({ open: false });
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.receive("t3code://new?prompt=hi");
      assert.strictEqual(revealed.length, 1);
      assert.deepStrictEqual(sent, []);

      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, ["t3code://new?prompt=hi"]);
    }).pipe(Effect.provide(layer));
  });
});
