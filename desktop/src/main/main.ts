/**
 * Electron main process: one window running the app's Expo web build, plus the Node-side handlers the
 * renderer's shims reach through window.boarNative (see shared/bridge.ts and handlers/).
 *
 *   BOAR_DEV_URL=http://localhost:8081  load the Expo dev server (npm run dev sets it)
 *   (unset)                             load web-dist/ (npm run build:web) through app://boar/
 *   BOAR_SCREENSHOT=<file.png>          capture the window a few seconds after load, then quit
 *   BOAR_USER_DATA=<dir>                use this data folder instead of %APPDATA%\BOAR (tests, e2e)
 */
import { app, BrowserWindow, ipcMain, Menu, net, protocol, screen, session, shell } from "electron";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guardedHandle, type HandlerContext } from "./handlers/context";
import { registerAll } from "./handlers/index";
import { hideOnClose } from "./handlers/folder-watch";
import { snapshot } from "./handlers/ram-monitor";
import { appMenu } from "./menu";
import { loadWindowState, restorable, saveWindowState } from "./window-state";
import PACKAGES from "../shared/packages.json";

const DEV_URL = process.env.BOAR_DEV_URL;
const WEB_DIST = path.join(__dirname, "../../web-dist");
const APP_ORIGIN = "app://boar";
/** Every URL of the app's own pages starts with this; anything else is foreign (navigation, IPC). */
const APP_PREFIX = DEV_URL ? new URL(DEV_URL).origin + "/" : `${APP_ORIGIN}/`;

// Only for app:// (prod). The dev server stays without one: Metro's dev bundle needs eval.
// 'unsafe-inline' styles: the export's index.html has an inline <style>, and react-native-web writes its styles
// into <style> tags and style attributes at runtime.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  // Hugging Face's API, for Settings > Browse Hugging Face models (src/services/modelBrowser.ts); model files
  // themselves download in main (downloadManager), not from the page.
  "connect-src 'self' https://huggingface.co",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

// app:// instead of file://: the export references /_expo/static/... and /assets/... as absolute paths,
// which under file:// would point at the drive root. "standard" makes app://boar/ behave like an origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Before the single-instance lock: the lock lives in userData, so a test copy doesn't collide with the real app.
if (process.env.BOAR_USER_DATA) app.setPath("userData", path.resolve(process.env.BOAR_USER_DATA));

// A second launch just focuses the first window (second-instance below).
if (!app.requestSingleInstanceLock()) app.exit(0);

let win: BrowserWindow | null = null;
let quitting = false;
app.on("before-quit", () => (quitting = true));

const dataDir = app.getPath("userData");
// The renderer only ever sees these two folders, not the rest of userData (Chromium's profile: cookies, storage...).
// "app-cache", not "cache": on a case-insensitive disk that would be Chromium's own <userData>/Cache.
const roots = { document: path.join(dataDir, "documents"), cache: path.join(dataDir, "app-cache") };
for (const d of Object.values(roots)) mkdirSync(d, { recursive: true });
// file:// URIs ending in "/" (expo-file-system's documentDirectory shape); pathToFileURL encodes # and %.
const dirUri = (d: string) => pathToFileURL(d).href + "/";
const dirs = { document: dirUri(roots.document), cache: dirUri(roots.cache) };

const ctx: HandlerContext = {
  ipcMain: guardedHandle(ipcMain, APP_PREFIX),
  roots,
  send: (channel, ...args) => win?.webContents.send(channel, ...args),
  webContents: () => win?.webContents ?? null,
};

function serveWebDist(): void {
  protocol.handle("app", async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    let file = path.join(WEB_DIST, rel);
    if (!file.startsWith(WEB_DIST + path.sep)) return new Response("forbidden", { status: 403 });
    // Single-page export: anything that isn't a file is the app.
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) file = path.join(WEB_DIST, "index.html");
    const res = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow(): void {
  const stateFile = path.join(dataDir, "window-state.json");
  const saved = restorable(loadWindowState(stateFile), screen.getAllDisplays().map((d) => d.workArea));
  win = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: "#17110D",
    title: "BOAR",
    autoHideMenuBar: true, // Alt shows the menu (menu.ts)
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Read synchronously by the preload (see preload.ts): the page's first reads can't wait for IPC.
      additionalArguments: [`--boar-init=${JSON.stringify(boarInit())}`],
    },
  });
  if (saved?.maximized) win.maximize();
  win.on("close", (e) => {
    saveWindowState(stateFile, { ...win!.getNormalBounds(), maximized: win!.isMaximized() });
    // "Keep running in the tray" (Settings, off by default): closing hides; the tray's Quit really quits.
    if (hideOnClose() && !quitting) {
      e.preventDefault();
      win!.hide();
    }
  });

  // By prefix, not URL.origin: that is "null" for file:, data: and custom schemes, so it would match them all.
  const external = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  const guard = (e: Electron.Event, url: string) => {
    if (!url.startsWith(APP_PREFIX)) {
      e.preventDefault();
      external(url);
    }
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });

  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
  win.on("closed", () => (win = null));

  const shot = process.env.BOAR_SCREENSHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        // stayHidden + retry: a background/occluded window sometimes captures as an empty image.
        win!.show();
        let img = await win!.webContents.capturePage(undefined, { stayHidden: true });
        for (let i = 0; i < 5 && img.isEmpty(); i++) {
          await new Promise((r) => setTimeout(r, 1000));
          img = await win!.webContents.capturePage(undefined, { stayHidden: true });
        }
        writeFileSync(shot, img.toPNG());
        app.quit();
      }, Number(process.env.BOAR_SCREENSHOT_DELAY_MS ?? 8000)),
    );
  }
}

function boarInit() {
  const { totalRamBytes, availableRamBytes } = snapshot();
  return { dirs, ram: { totalRamBytes, availableRamBytes }, packages: Object.values(PACKAGES) };
}

app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.show(); // hidden in the tray (folder-watch.ts)
  win?.focus();
});
app.on("window-all-closed", () => app.quit());

void app.whenReady().then(() => {
  // The app needs no camera, location, notifications...; only the clipboard write behind Share (rn-share.ts) and the
  // microphone for voice input (shims/voice-input.ts), audio only, for the app's own page.
  // `origin + "/"`: Chromium may give "app://boar" or "app://boar/"; both start APP_PREFIX, "app://boarx/" doesn't.
  const ours = (origin: string | undefined) => !!origin && (origin + "/").startsWith(APP_PREFIX);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === "clipboard-sanitized-write") return callback(true);
    const media = details as Electron.MediaAccessPermissionRequest;
    const micOnly = permission === "media" && media.mediaTypes?.length === 1 && media.mediaTypes[0] === "audio";
    callback(micOnly && media.isMainFrame && ours(media.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission === "clipboard-sanitized-write") return true;
    return permission === "media" && details.mediaType === "audio" && details.isMainFrame && ours(origin);
  });
  if (!DEV_URL) serveWebDist();
  registerAll(ctx);
  Menu.setApplicationMenu(appMenu(() => win, Boolean(DEV_URL)));
  createWindow();
});
