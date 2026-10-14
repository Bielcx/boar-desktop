import { mkdirSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import type { BoarNative } from "../shared/bridge";
import { guardedHandle, type HandlerContext } from "../main/handlers/context";

/** The app's page as the IPC guard sees it (main.ts serves the app from app://boar/). */
export const APP_PREFIX = "app://boar/";

/**
 * In-process stand-in for Electron IPC, for tests: shims call window.boarNative, which runs the main-side
 * handlers directly. Arguments and results go through structuredClone like real IPC, so passing a function
 * or a class instance fails here the same way it would in the app. Handlers are registered through the same
 * guardedHandle as in main.ts, and calls come from a fake main frame at `frameUrl` (the app's page by default).
 * The renderer's folders are <dataDir>/documents and <dataDir>/app-cache, as in the app.
 *
 *   const { native, ctx } = loopback(dataDir);
 *   register(ctx);                 // the handler module under test
 *   globalThis.window = { boarNative: native } as any;
 */
export function loopback(dataDir: string, frameUrl = `${APP_PREFIX}index.html`): { native: BoarNative; ctx: HandlerContext } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const toUri = (p: string) => "file:///" + p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/");
  const roots = { document: dataDir + "/documents", cache: dataDir + "/app-cache" };
  for (const d of Object.values(roots)) mkdirSync(d, { recursive: true });
  const frame = { url: frameUrl, parent: null };
  const event = { sender: { mainFrame: frame }, senderFrame: frame };

  const raw = {
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, fn);
    },
  };
  const ctx: HandlerContext = {
    ipcMain: guardedHandle(raw as unknown as HandlerContext["ipcMain"], APP_PREFIX),
    roots,
    send(channel: string, ...args: unknown[]) {
      const payload = structuredClone(args);
      for (const l of listeners.get(channel) ?? []) l(...payload);
    },
    webContents: () => null,
  };

  const native: BoarNative = {
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return structuredClone(await fn(event, ...structuredClone(args))) as T;
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    platform: process.platform,
    dirs: { document: toUri(roots.document), cache: toUri(roots.cache) },
    ram: { totalRamBytes: totalmem(), availableRamBytes: freemem() },
  };
  return { native, ctx };
}
