// The "FolderWatch" native module on desktop (src/services/folderWatch.ts finds it through the expo-modules-core shim):
// watched folders live in main (handlers/folder-watch.ts), which picks them in a native dialog and sends batches of
// copied files to import.
import { native } from "../shared/bridge";

const call = <T>(method: string, ...args: unknown[]) => native().invoke<T>(`folder-watch:${method}`, ...args);

export const FolderWatch = {
  get: () => call("get"),
  addFolder: () => call("addFolder"),
  removeFolder: (id: string) => call("removeFolder", id),
  setPaused: (paused: boolean) => call("setPaused", paused),
  setTrayOnClose: (on: boolean) => call("setTrayOnClose", on),
  ready: (labels: Record<string, string>, existing: string[]) => call<void>("ready", labels, existing),
  done: (batchId: string, result: { ok: boolean; resync?: boolean; message?: string }) => call<void>("done", batchId, result),
  onBatch: (listener: (batch: unknown) => void) => native().on("folder-watch:batch", listener),
};
