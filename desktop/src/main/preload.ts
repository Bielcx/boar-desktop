/**
 * The only bridge between the page and Node. Runs sandboxed, before the page, in an isolated world: it
 * can only require "electron", so everything it needs is in this file. Exposes BoarNative (shared/bridge.ts)
 * and nothing else: no raw ipcRenderer, only "<pkg>:<method>" channels of the app's packages.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { BoarNative } from "../shared/bridge";

// main.ts passes what the page needs synchronously as an argument (a sandboxed preload can only require "electron",
// so it can't read shared/packages.json itself): the data dirs and first RAM reading, which shims read at import
// time, and the allowed channel prefixes (the values of shared/packages.json).
const arg = process.argv.find((a) => a.startsWith("--boar-init="));
const init = JSON.parse(arg!.slice("--boar-init=".length)) as Pick<BoarNative, "dirs" | "ram"> & { packages: string[] };
const PACKAGES = init.packages;

function check(channel: unknown): string {
  const c = String(channel);
  const i = c.indexOf(":");
  if (i <= 0 || !PACKAGES.includes(c.slice(0, i)) || !/^[\w.:-]+$/.test(c.slice(i + 1))) {
    throw new Error(`boarNative: channel not allowed: ${c}`);
  }
  return c;
}

const boarNative: BoarNative = {
  invoke: (channel, ...args) => ipcRenderer.invoke(check(channel), ...args),
  on(channel, listener) {
    const wrapped = (_e: unknown, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(check(channel), wrapped);
    return () => void ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
  dirs: init.dirs,
  ram: init.ram,
};

contextBridge.exposeInMainWorld("boarNative", boarNative);
