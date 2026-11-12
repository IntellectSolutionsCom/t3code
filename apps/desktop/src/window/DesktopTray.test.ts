import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

const electronMock = vi.hoisted(() => {
  interface FakeTray {
    image: unknown;
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }
  const state = {
    trays: [] as FakeTray[],
    onCreate: (_tray: FakeTray) => {},
    onDestroy: (_tray: FakeTray) => {},
  };
  const resizedImage = { isEmpty: vi.fn(() => false) };
  const resize = vi.fn(() => resizedImage);
  const createFromPath = vi.fn((_path: string) => ({ resize }));
  const createTray = function (this: FakeTray, image: unknown) {
    this.image = image;
    this.setToolTip = vi.fn();
    this.setContextMenu = vi.fn();
    this.on = vi.fn();
    this.destroy = vi.fn(() => state.onDestroy(this));
    state.trays.push(this);
    state.onCreate(this);
  };
  const Tray = vi.fn(createTray);
  const buildFromTemplate = vi.fn((template: ReadonlyArray<Record<string, unknown>>) => ({
    template,
  }));
  return { state, resizedImage, resize, createFromPath, createTray, Tray, buildFromTemplate };
});

vi.mock("electron", () => ({
  Tray: electronMock.Tray,
  Menu: { buildFromTemplate: electronMock.buildFromTemplate },
  nativeImage: { createFromPath: electronMock.createFromPath },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

type FakeTray = (typeof electronMock.state.trays)[number];
const setup = Effect.fn(function* (input: {
  readonly platform: NodeJS.Platform;
  readonly iconPaths?: () => DesktopAssets.DesktopIconPaths;
}) {
  electronMock.state.trays.length = 0;
  electronMock.Tray.mockReset().mockImplementation(electronMock.createTray);
  electronMock.buildFromTemplate.mockClear();
  electronMock.createFromPath.mockClear();
  electronMock.resize.mockClear();
  electronMock.resizedImage.isEmpty.mockReset().mockReturnValue(false);

  const created = yield* Queue.unbounded<FakeTray>();
  const destroyed = yield* Queue.unbounded<FakeTray>();
  const warnings = yield* Queue.unbounded<string>();
  const shown = yield* Queue.unbounded<void>();
  electronMock.state.onCreate = (tray) => Queue.offerUnsafe(created, tray);
  electronMock.state.onDestroy = (tray) => Queue.offerUnsafe(destroyed, tray);

  const iconPaths =
    input.iconPaths ??
    (() => ({
      ico: Option.some("C:\\icons\\t3.ico"),
      icns: Option.none<string>(),
      png: Option.some("/icons/t3.png"),
    }));
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") Queue.offerUnsafe(warnings, String(message));
  });
  // Every processed value that shows the tray ends a show span, even when the tray already exists.
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        if (span.name === "desktop.tray.show") Queue.offerUnsafe(shown, undefined);
      };
      return span;
    },
  });
  const layer = Layer.mergeAll(
    DesktopState.layer,
    Layer.succeed(DesktopAssets.DesktopAssets, {
      iconPaths: Effect.sync(iconPaths),
      resolveResourcePath: () => Effect.succeed(Option.none<string>()),
    }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: input.platform,
      displayName: "T3 Code",
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(DesktopWindow.DesktopWindow)({ activate: Effect.void }),
    Layer.mock(ElectronApp.ElectronApp)({ quit: Effect.void }),
    Logger.layer([logger], { mergeWithExisting: false }),
    Layer.succeed(Tracer.Tracer, tracer),
  );
  const context = yield* Layer.build(layer);
  const state = (yield* DesktopState.DesktopState.pipe(Effect.provide(context)))
    .keepRunningWithoutWindow;
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const listen = (mode: Parameters<typeof DesktopTray.listen>[0]) =>
    DesktopTray.listen(mode).pipe(Effect.provide(context), Scope.provide(scope));
  const setWindowless = (value: boolean) => SubscriptionRef.set(state, value);
  const close = Scope.close(scope, Exit.void);
  return { created, destroyed, warnings, shown, listen, setWindowless, close };
});

const menuOf = (tray: FakeTray): ReadonlyArray<unknown> =>
  (tray.setContextMenu.mock.calls[0]![0] as { template: ReadonlyArray<unknown> }).template;

describe("DesktopTray.listen", () => {
  it.effect.each(["linux", "win32"] as const)("shows one tray while windowless on %s", (platform) =>
    Effect.gen(function* () {
      const t = yield* setup({ platform });
      yield* t.listen("whileWindowless");
      yield* t.setWindowless(true);

      const tray = yield* Queue.take(t.created);
      assert.equal(electronMock.Tray.mock.calls.length, 1);
      if (platform === "win32") assert.equal(tray.image, "C:\\icons\\t3.ico");
      assert.equal(menuOf(tray).length, 3);
    }),
  );

  it.effect("destroys the tray when a window returns and makes a new one next time", () =>
    Effect.gen(function* () {
      const t = yield* setup({ platform: "linux" });
      yield* t.listen("whileWindowless");
      yield* t.setWindowless(true);
      const first = yield* Queue.take(t.created);

      yield* t.setWindowless(false);
      assert.strictEqual(yield* Queue.take(t.destroyed), first);

      yield* t.setWindowless(true);
      const second = yield* Queue.take(t.created);
      assert.notStrictEqual(second, first);
      assert.equal(second.destroy.mock.calls.length, 0);
    }),
  );

  it.effect.each(["whileWindowless", "always"] as const)(
    "never shows a tray on macOS (%s)",
    (mode) =>
      Effect.gen(function* () {
        const t = yield* setup({ platform: "darwin" });
        // On macOS listen returns without forking a listener, so nothing can run later.
        yield* t.listen(mode);
        yield* t.setWindowless(true);
        assert.equal(electronMock.Tray.mock.calls.length, 0);
      }),
  );

  it.effect.each([
    {
      name: "a missing png",
      arrange: (paths: { missing: boolean }) => {
        paths.missing = true;
      },
    },
    {
      name: "an empty image",
      arrange: () => {
        electronMock.resizedImage.isEmpty.mockReturnValueOnce(true);
      },
    },
    {
      name: "a throwing Tray constructor",
      arrange: () => {
        electronMock.Tray.mockImplementationOnce(function () {
          throw new Error("tray unavailable");
        });
      },
    },
    {
      name: "a throwing menu",
      arrange: () => {
        electronMock.buildFromTemplate.mockImplementationOnce(() => {
          throw new Error("menu unavailable");
        });
      },
    },
  ])("warns about $name and tries again in the next windowless period", ({ name, arrange }) =>
    Effect.gen(function* () {
      const paths = { missing: false };
      const t = yield* setup({
        platform: "linux",
        iconPaths: () => ({
          ico: Option.none(),
          icns: Option.none(),
          png: paths.missing ? Option.none() : Option.some("/icons/t3.png"),
        }),
      });
      arrange(paths);
      yield* t.listen("whileWindowless");
      yield* t.setWindowless(true);
      yield* Queue.take(t.warnings);
      if (name === "a throwing menu") {
        const unfinished = yield* Queue.take(t.created);
        assert.strictEqual(yield* Queue.take(t.destroyed), unfinished);
      }
      paths.missing = false;

      yield* t.setWindowless(false);
      yield* t.setWindowless(true);
      const tray = yield* Queue.take(t.created);
      assert.equal(tray.destroy.mock.calls.length, 0);
      assert.equal(menuOf(tray).length, 3);
    }),
  );

  it.effect("destroys the tray when the scope closes", () =>
    Effect.gen(function* () {
      const t = yield* setup({ platform: "linux" });
      yield* t.listen("whileWindowless");
      yield* t.setWindowless(true);
      const tray = yield* Queue.take(t.created);
      yield* t.close;
      assert.strictEqual(yield* Queue.take(t.destroyed), tray);
    }),
  );

  it.effect("always shows the tray, even with a window", () =>
    Effect.gen(function* () {
      const t = yield* setup({ platform: "linux" });
      yield* t.listen("always");
      const tray = yield* Queue.take(t.created);

      yield* Queue.take(t.shown);

      yield* t.setWindowless(true);
      yield* t.setWindowless(false);
      yield* Queue.take(t.shown);
      yield* Queue.take(t.shown);
      assert.equal(electronMock.Tray.mock.calls.length, 1);
      assert.equal(tray.destroy.mock.calls.length, 0);
      yield* t.close;
      assert.strictEqual(yield* Queue.take(t.destroyed), tray);
    }),
  );
});
