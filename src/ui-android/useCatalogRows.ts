import { useCallback, useEffect, useState } from "react";
import type { CatalogModel } from "../models/manifest";
import { ModelManager } from "../models/ModelManager";
import { getDownloadState, isDownloading, subscribeDownloads } from "../services/downloadManager";
import type { CatalogRowState } from "./CatalogItemCard";

const modelManager = new ModelManager();

/**
 * Whether each catalog item is on disk and how its download is going, for a screen that lists a few of them (the
 * Knowledge screen's packs). ponytail: ModelSetupScreen keeps its own copy of getRow, since it also merges the
 * discovered Hugging Face models; fold it into this hook if a third screen needs it.
 */
export function useCatalogRows(items: CatalogModel[]) {
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [, forceRender] = useState(0);

  useEffect(() => subscribeDownloads(() => forceRender((n) => n + 1)), []);

  const refresh = useCallback(async () => {
    const statuses = await Promise.all(items.map((m) => modelManager.statusOf(m)));
    setPresence(Object.fromEntries(statuses.map((s) => [s.asset.id, s.present])));
  }, [items]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const getRow = (item: CatalogModel): CatalogRowState => {
    const dl = getDownloadState(item.id);
    return {
      present: presence[item.id] ?? false,
      downloading: isDownloading(item.id),
      progress: dl?.progress ?? 0,
      error: dl?.error ?? null,
      bytesWritten: dl?.bytesWritten,
      bytesExpected: dl?.bytesExpected,
      speedBytesPerSec: dl?.speedBytesPerSec,
      etaSeconds: dl?.etaSeconds,
    };
  };

  return { getRow, refresh, deleteModel: (m: CatalogModel) => modelManager.deleteModel(m) };
}
