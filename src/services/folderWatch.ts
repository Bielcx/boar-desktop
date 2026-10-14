/**
 * Watched folders ("javali de plantão"), desktop only: a native "FolderWatch" module (desktop/src/main/handlers/
 * folder-watch.ts) watches the folders the user picked and sends batches of copied files; this side imports each
 * batch into the folder's collection (documentImporter.ts syncWatchedFolder) and reports back, which is when the
 * desktop shows a notification. Android has no such module: folderWatchAvailable() is false and the setting is hidden.
 */
import { requireOptionalNativeModule } from "expo-modules-core";
import i18n from "i18next";
import { listCustomCollections, syncWatchedFolder, type WatchedFolderBatch } from "./documentImporter";

export interface WatchedFolder {
  id: string;
  path: string;
  name: string;
}
export interface FolderWatchState {
  folders: WatchedFolder[];
  paused: boolean;
  trayOnClose: boolean;
}

interface FolderWatchModule {
  get(): Promise<FolderWatchState>;
  addFolder(): Promise<FolderWatchState>;
  removeFolder(id: string): Promise<FolderWatchState>;
  setPaused(paused: boolean): Promise<FolderWatchState>;
  setTrayOnClose(on: boolean): Promise<FolderWatchState>;
  ready(labels: Record<string, string>, existing: string[]): Promise<void>;
  done(batchId: string, result: { ok: boolean; resync?: boolean; message?: string }): Promise<void>;
  onBatch(listener: (batch: WatchedFolderBatch & { batchId: string }) => void): () => void;
}

export const folderWatch = requireOptionalNativeModule<FolderWatchModule>("FolderWatch");

export function folderWatchAvailable(): boolean {
  return folderWatch !== null;
}

/** Starts taking batches; call once the chat (and its embedding model) is up. Returns a stop function. */
export function startFolderWatch(): () => void {
  const fw = folderWatch;
  if (!fw) return () => {};
  const off = fw.onBatch(async (batch) => {
    try {
      const r = await syncWatchedFolder(batch);
      if (!r) return void (await fw.done(batch.batchId, { ok: false, resync: true }));
      const message = r.imported > 0 ? i18n.t("folderWatch.notification", { count: r.imported, name: batch.name }) : undefined;
      await fw.done(batch.batchId, { ok: true, message });
    } catch (e) {
      console.warn("[folder-watch] batch failed, will retry:", e);
      await fw.done(batch.batchId, { ok: false }).catch(() => {});
    }
  });
  void listCustomCollections().then((cs) =>
    fw.ready(
      {
        open: i18n.t("folderWatch.tray.open"),
        pause: i18n.t("folderWatch.tray.pause"),
        resume: i18n.t("folderWatch.tray.resume"),
        quit: i18n.t("folderWatch.tray.quit"),
      },
      cs.map((c) => c.id)
    )
  );
  return off;
}
