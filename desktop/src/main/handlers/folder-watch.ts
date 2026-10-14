import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { onPageGone, type HandlerContext } from "./context";
import { diff, goodTimeForHeavyWork, isHeavy, scanFolder, watchFolder, type Manifest } from "../watch";

/**
 * "FolderWatch" (src/services/folderWatch.ts): the "javali de plantão". Folders the user picked in a native dialog
 * (never a path sent by the page) are watched here; new, changed and deleted files go to the page as a batch of
 * copies in <cache>/FolderWatch/, which it imports with the same code as the picker (documentImporter.ts
 * syncWatchedFolder) and then confirms with `done`. Only then is the folder's manifest (what was imported) saved, so
 * a failed or interrupted import is simply planned again on the next scan. Big batches wait for an idle computer on
 * mains power. A tray icon (the mini boar) appears while a folder is watched or "keep running in the tray" is on.
 * Everything is off until the user adds a folder.
 */
interface Folder {
  id: string;
  path: string;
  name: string;
}
interface State {
  folders: Folder[];
  paused: boolean;
  trayOnClose: boolean;
  manifests: Record<string, Manifest>;
}
interface Labels {
  open: string;
  pause: string;
  resume: string;
  quit: string;
}
interface Asset {
  uri: string;
  name: string;
  size: number;
}
/** What the page gets; collectionId is stable per folder so later batches update the same collection. */
export interface Batch {
  batchId: string;
  collectionId: string;
  name: string;
  /** Nothing was imported before (new folder, or the collection is gone): the page starts the collection over. */
  full: boolean;
  upserts: Asset[];
  removes: string[];
  /** Every file now in the folder, and their total size: the collection's summary line. */
  files: string[];
  sizeBytes: number;
}

const DEBOUNCE_MS = 1500;
/** Rescan every folder this often: retries, big batches waiting for a good moment, events fs.watch missed. */
const TICK_MS = 60_000;
const MAX_LABEL = 200;

let state: State = { folders: [], paused: false, trayOnClose: false, manifests: {} };
let stateFile = "";
let labels: Labels = { open: "Open BOAR", pause: "Pause folder watch", resume: "Resume folder watch", quit: "Quit" };
let tray: Tray | null = null;
let ready = false;
let inFlight: { batchId: string; folderId: string; manifest: Manifest } | null = null;
let pumping = false;
const stops = new Map<string, () => void>();

/** main.ts asks this on the window's close: true = hide to the tray instead (off by default). */
export function hideOnClose(): boolean {
  return state.trayOnClose;
}

function save(): void {
  try {
    writeFileSync(stateFile, JSON.stringify(state));
  } catch (e) {
    console.warn("[folder-watch] couldn't save state:", e);
  }
}

function load(): void {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<State>;
    state = {
      folders: Array.isArray(s.folders) ? s.folders : [],
      paused: s.paused === true,
      trayOnClose: s.trayOnClose === true,
      manifests: s.manifests && typeof s.manifests === "object" ? s.manifests : {},
    };
  } catch {
    // first run, or an unreadable file: start with nothing watched
  }
}

const collectionIdOf = (f: Folder) => `custom-watch-${f.id}`;

function publicState() {
  return {
    folders: state.folders.map(({ id, path, name }) => ({ id, path, name })),
    paused: state.paused,
    trayOnClose: state.trayOnClose,
  };
}

function window(ctx: HandlerContext): BrowserWindow | null {
  const wc = ctx.webContents();
  return wc ? BrowserWindow.fromWebContents(wc) : null;
}

function showWindow(ctx: HandlerContext): void {
  const w = window(ctx);
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function mascotIcon(): Electron.NativeImage {
  // Packaged: electron-builder's extraResources copies it next to app.asar. Dev: the repo's own art.
  const file = app.isPackaged
    ? path.join(process.resourcesPath, "mascot.png")
    : path.join(__dirname, "../../../../assets/mascot/filhote.png");
  return nativeImage.createFromPath(file).resize({ width: 32, height: 32, quality: "best" });
}

function updateTray(ctx: HandlerContext): void {
  const wanted = state.folders.length > 0 || state.trayOnClose;
  if (!wanted) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(mascotIcon());
    tray.setToolTip("BOAR");
    tray.on("click", () => showWindow(ctx));
  }
  const items: Electron.MenuItemConstructorOptions[] = [{ id: "open", label: labels.open, click: () => showWindow(ctx) }];
  if (state.folders.length > 0) {
    items.push({
      id: "pause",
      label: state.paused ? labels.resume : labels.pause,
      click: () => setPaused(ctx, !state.paused),
    });
  }
  items.push({ type: "separator" }, { id: "quit", label: labels.quit, click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function setPaused(ctx: HandlerContext, paused: boolean): void {
  state.paused = paused;
  save();
  updateTray(ctx);
  if (!paused) void pump(ctx);
}

function startWatching(ctx: HandlerContext, f: Folder): void {
  stops.get(f.id)?.();
  stops.set(f.id, watchFolder(f.path, DEBOUNCE_MS, () => void pump(ctx)));
}

/**
 * Sends the next folder with something to import, one batch at a time (embedding is one at a time anyway). A folder
 * whose batch is big and the moment bad (on battery, or someone at the keyboard) is skipped until a later tick.
 */
async function pump(ctx: HandlerContext): Promise<void> {
  if (!ready || inFlight || state.paused || pumping) return;
  pumping = true;
  try {
    for (const f of state.folders) {
      const now = await scanFolder(f.path).catch(() => null);
      if (!now) continue; // folder gone or unreadable (unplugged drive): leave its collection alone
      const before = state.manifests[f.id] ?? {};
      const plan = diff(now, before);
      if (plan.upserts.length === 0 && plan.removes.length === 0) continue;
      if (isHeavy(plan, now) && !goodTimeForHeavyWork(powerMonitor)) continue;

      // The page may only read inside the app's folders: copy each file into <cache>/FolderWatch/. A file that
      // can't be copied (still being written, locked) keeps its old manifest entry and is tried again later.
      const manifest: Manifest = { ...now };
      const upserts: Asset[] = [];
      for (const name of plan.upserts) {
        const dest = path.join(ctx.roots.cache, "FolderWatch", `${randomUUID()}-${name}`);
        try {
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(path.join(f.path, name), dest);
          upserts.push({ uri: pathToFileURL(dest).href, name, size: now[name][0] });
        } catch {
          if (before[name]) manifest[name] = before[name];
          else delete manifest[name];
        }
      }
      const batch: Batch = {
        batchId: randomUUID(),
        collectionId: collectionIdOf(f),
        name: f.name,
        full: Object.keys(before).length === 0,
        upserts,
        removes: plan.removes,
        files: Object.keys(manifest),
        sizeBytes: Object.values(manifest).reduce((s, [size]) => s + size, 0),
      };
      if (!ready) return; // the page went away while copying
      inFlight = { batchId: batch.batchId, folderId: f.id, manifest };
      ctx.send("folder-watch:batch", batch);
      return;
    }
  } finally {
    pumping = false;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.slice(0, MAX_LABEL) : "");

export function register(ctx: HandlerContext): void {
  stateFile = path.join(app.getPath("userData"), "folder-watch.json");
  load();
  // Copies of a batch that never finished (the app was closed mid-import).
  rmSync(path.join(ctx.roots.cache, "FolderWatch"), { recursive: true, force: true });
  if (process.platform === "win32") app.setAppUserModelId("io.github.bielcx.boar"); // toasts need it outside the installer

  void app.whenReady().then(() => {
    for (const f of state.folders) startWatching(ctx, f);
    updateTray(ctx);
    setInterval(() => void pump(ctx), TICK_MS).unref();
    powerMonitor.on("on-ac", () => void pump(ctx));
  });

  ctx.ipcMain.handle("folder-watch:get", () => publicState());

  ctx.ipcMain.handle("folder-watch:addFolder", async () => {
    const w = window(ctx);
    const opts: Electron.OpenDialogOptions = { properties: ["openDirectory"] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    const dir = r.filePaths[0];
    if (r.canceled || !dir || /^[\\/]{2}/.test(dir)) return publicState(); // no network shares (see safePath.ts)
    if (!state.folders.some((f) => path.resolve(f.path) === path.resolve(dir))) {
      const f: Folder = { id: randomUUID().slice(0, 8), path: dir, name: path.basename(dir) || dir };
      state.folders.push(f);
      save();
      startWatching(ctx, f);
      updateTray(ctx);
      void pump(ctx);
    }
    return publicState();
  });

  // The folder stops being watched; its collection stays, as an ordinary one the user can remove.
  ctx.ipcMain.handle("folder-watch:removeFolder", (_e, id: unknown) => {
    stops.get(String(id))?.();
    stops.delete(String(id));
    state.folders = state.folders.filter((f) => f.id !== id);
    delete state.manifests[String(id)];
    save();
    updateTray(ctx);
    return publicState();
  });

  ctx.ipcMain.handle("folder-watch:setPaused", (_e, paused: unknown) => {
    setPaused(ctx, paused === true);
    return publicState();
  });

  ctx.ipcMain.handle("folder-watch:setTrayOnClose", (_e, on: unknown) => {
    state.trayOnClose = on === true;
    save();
    updateTray(ctx);
    return publicState();
  });

  // The page is listening for batches. `existing`: the watched collections it has; a folder whose collection is gone
  // (removed by the user, or the app was reset) is imported again from scratch. `l`: the tray menu in its language.
  ctx.ipcMain.handle("folder-watch:ready", (e, l: Partial<Record<keyof Labels, unknown>>, existing: unknown) => {
    labels = { open: str(l?.open) || labels.open, pause: str(l?.pause) || labels.pause, resume: str(l?.resume) || labels.resume, quit: str(l?.quit) || labels.quit };
    const have = new Set(Array.isArray(existing) ? existing.map(String) : []);
    for (const f of state.folders) if (!have.has(collectionIdOf(f))) delete state.manifests[f.id];
    save();
    updateTray(ctx);
    ready = true;
    inFlight = null;
    onPageGone(e.sender, () => {
      ready = false;
      inFlight = null;
    });
    void pump(ctx);
  });

  // The page finished a batch. ok: what was planned is now the folder's manifest; `message` (in the page's language)
  // becomes a system notification. resync: the collection was gone, so start the folder over.
  ctx.ipcMain.handle("folder-watch:done", (_e, batchId: unknown, r: { ok?: unknown; resync?: unknown; message?: unknown }) => {
    if (!inFlight || inFlight.batchId !== batchId) return;
    const { folderId, manifest } = inFlight;
    inFlight = null;
    if (r?.resync === true) delete state.manifests[folderId];
    else if (r?.ok === true && state.folders.some((f) => f.id === folderId)) state.manifests[folderId] = manifest;
    save();
    const message = str(r?.message);
    if (r?.ok === true && message && Notification.isSupported()) {
      const n = new Notification({ title: "BOAR", body: message, icon: mascotIcon() });
      n.on("click", () => showWindow(ctx));
      n.show();
    }
    // A failure waits for the next tick instead of retrying at once (the embedder may still be loading).
    if (r?.ok === true || r?.resync === true) void pump(ctx);
  });
}
