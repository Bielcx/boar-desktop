import type { IpcMain, WebContents } from "electron";

/** What each handler module gets from main.ts. */
export interface HandlerContext {
  /**
   * Registers an IPC handler. main.ts wraps ipcMain.handle so a call is only served when it comes from the app's own
   * page (main frame, app origin); a frame or page from anywhere else is refused before the handler runs.
   */
  ipcMain: Pick<IpcMain, "handle">;
  /** The app's documents and cache folders (expo's documentDirectory / cacheDirectory). Every path the renderer sends must resolve inside one. */
  roots: { document: string; cache: string };
  /** Pushes an event to the renderer (BoarNative.on). Null until the window exists. */
  send(channel: string, ...args: unknown[]): void;
  webContents(): WebContents | null;
  /** The MCP server (src/mcp/server.ts): databases open read-only, so nothing can change the library. */
  readOnly?: boolean;
}

/** Folders the renderer's file:// URIs may point into (safePath's roots). */
export const fileRoots = (ctx: HandlerContext) => [ctx.roots.document, ctx.roots.cache];

/**
 * ipcMain.handle, refusing any call that doesn't come from the main frame of a page under `appPrefix` (the app's
 * own origin). An iframe, or the window after a navigation the guards missed, gets an error instead of Node.
 */
export function guardedHandle(ipcMain: Pick<IpcMain, "handle">, appPrefix: string): Pick<IpcMain, "handle"> {
  return {
    handle: (channel, listener) =>
      ipcMain.handle(channel, (event, ...args) => {
        const frame = event.senderFrame;
        if (!frame || frame.parent !== null || !frame.url.startsWith(appPrefix)) {
          throw new Error(`IPC refused: ${channel} from ${frame?.url ?? "a closed frame"}`);
        }
        return listener(event, ...args);
      }),
  };
}

const watched = new WeakMap<object, Array<() => void>>();

/**
 * Runs `fn` when the page behind `sender` goes away: the WebContents is destroyed, or its main frame navigates to a
 * new document (a reload included). For per-page state in main (open databases, loaded models) that a reloaded page
 * can no longer reach. Listeners are added once per sender; `sender` may be a test stand-in without events.
 */
export function onPageGone(sender: WebContents | null | undefined, fn: () => void): void {
  if (!sender) return;
  let fns = watched.get(sender);
  if (!fns) {
    const list: Array<() => void> = [];
    fns = list;
    watched.set(sender, list);
    const fire = () => list.forEach((f) => f());
    sender.once?.("destroyed", fire);
    // Event details moved onto the event object in newer Electron; older ones pass (url, isInPlace, isMainFrame).
    sender.on?.("did-start-navigation", (e: any, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if ((e?.isMainFrame ?? isMainFrame) && !(e?.isSameDocument ?? isInPlace)) fire();
    });
  }
  if (!fns.includes(fn)) fns.push(fn);
}
