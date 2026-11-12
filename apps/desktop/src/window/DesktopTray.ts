import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const { logWarning } = makeComponentLogger("desktop-tray");

type TrayShown = "whileWindowless" | "always";

// "whileWindowless": the tray shows only while Keep running has closed the window.
// "always": the tray shows for as long as T3 Code runs (Linux and Windows).
export const TRAY_SHOWN: TrayShown = "whileWindowless";

const isTrayShown = (input: {
  readonly mode: TrayShown;
  readonly platform: NodeJS.Platform;
  readonly windowless: boolean;
}) => input.platform !== "darwin" && (input.mode === "always" || input.windowless);

/** Shows a tray icon while the rule in `isTrayShown` holds, for the life of the calling scope. */
export const listen = Effect.fn("desktop.tray.listen")(function* (mode: TrayShown) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform === "darwin") return;
  const { keepRunningWithoutWindow } = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let tray: Electron.Tray | null = null;

  const activate = () => {
    void runPromise(
      desktopWindow.activate.pipe(
        Effect.catchCause((cause) => logWarning("failed to open the desktop window", { cause })),
      ),
    );
  };
  const quit = () => {
    void runPromise(
      electronApp.quit.pipe(
        Effect.catchCause((cause) => logWarning("failed to quit from the tray", { cause })),
      ),
    );
  };

  const destroyTray = Effect.sync(() => {
    const previous = tray;
    tray = null;
    previous?.destroy();
  });

  const show = Effect.fn("desktop.tray.show")(function* () {
    if (tray !== null) return;
    const iconPaths = yield* assets.iconPaths;
    const created = yield* Effect.sync(() => {
      if (environment.platform === "win32") {
        const icoPath = Option.getOrNull(iconPaths.ico);
        return icoPath === null ? null : new Electron.Tray(icoPath);
      }
      const pngPath = Option.getOrNull(iconPaths.png);
      if (pngPath === null) return null;
      const image = Electron.nativeImage.createFromPath(pngPath).resize({ width: 32, height: 32 });
      return image.isEmpty() ? null : new Electron.Tray(image);
    });
    if (created === null) {
      yield* logWarning("no tray icon image is available; the tray stays hidden");
      return;
    }
    tray = created;
    tray.setToolTip(environment.displayName);
    tray.setContextMenu(
      Electron.Menu.buildFromTemplate([
        { label: `Open ${environment.displayName}`, click: activate },
        { type: "separator" },
        { label: `Quit ${environment.displayName}`, click: quit },
      ]),
    );
    tray.on("click", activate);
  });

  const hide = Effect.fn("desktop.tray.hide")(function* () {
    yield* destroyTray;
  });

  const step = (windowless: boolean) =>
    (isTrayShown({ mode, platform: environment.platform, windowless }) ? show() : hide()).pipe(
      Effect.catchCause((cause) =>
        destroyTray.pipe(
          Effect.catchCause((cleanupCause) =>
            logWarning("failed to destroy the unfinished tray", { cause: cleanupCause }),
          ),
          Effect.andThen(logWarning("failed to update the system tray", { cause })),
        ),
      ),
    );

  // Registered before the fork, so it runs after the listener is interrupted.
  yield* Effect.addFinalizer(() => destroyTray.pipe(Effect.ignoreCause));

  yield* SubscriptionRef.changes(keepRunningWithoutWindow).pipe(
    Stream.changes,
    Stream.runForEach(step),
    Effect.forkScoped,
  );
});
