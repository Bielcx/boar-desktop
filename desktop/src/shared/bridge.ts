/**
 * The one contract between the renderer (the app's UI + engine, bundled by Metro) and the Electron
 * main process (Node: node-llama-cpp, node:sqlite, fs).
 *
 * Renderer side: each shim in desktop/src/shims/<pkg>.ts re-implements the subset of <pkg>'s API the
 * app uses, calling `window.boarNative`. Main side: desktop/src/main/handlers/<pkg>.ts registers the
 * matching channels. Channel names are "<pkg>:<method>", e.g. "llama.rn:completion".
 *
 * invoke: request/response. on: events pushed from main (e.g. streamed tokens, download progress);
 * returns an unsubscribe function. Event payloads carry an id so concurrent calls don't mix.
 */
export interface BoarNative {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
  /** process.platform of the host: "win32" | "darwin" | "linux". */
  platform: string;
  /** expo-file-system's documentDirectory / cacheDirectory: file:// URIs ending in "/", inside the app's data root. */
  dirs: { document: string; cache: string };
  /** RAM when the window opened, so ram-monitor's synchronous reads are right before its first IPC refresh. */
  ram: { totalRamBytes: number; availableRamBytes: number };
}

declare global {
  interface Window {
    boarNative: BoarNative;
  }
}

export function native(): BoarNative {
  return window.boarNative;
}
