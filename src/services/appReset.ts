import * as FileSystem from "expo-file-system/legacy";
import { llamaEngine } from "../inference/LlamaEngine";
import { embeddingEngine } from "../rag/embed";
import { cancelAllDownloads } from "./downloadManager";
import { clearVerifiedRecords } from "../models/ModelManager";
import { clearSettings } from "../models/settings";
import { clearDiscoveredModels } from "../models/discoveredModels";
import { runReset, runResetHooks } from "./resetOrder";

// Everything BOAR downloads or imports: models, knowledge packs, places packs,
// and the temp folder of an import that was interrupted.
const DATA_DIRS = ["models", "corpus", "poi", "imports"].map((d) => `${FileSystem.documentDirectory}${d}`);

/**
 * Full app data wipe ("Erase everything" in Settings). Everything persisted
 * lives in the SQLite knowledge base (chat history, all corpus/collection
 * chunks), in files under the document directory, or in small JSON files
 * (settings, the discovered-models list).
 *
 * The order and why no SQLite connection is closed are in resetOrder.ts
 * (closing one crashed natively, Prism RS-1). The stores in src/rag register
 * their "forget" and "wipe" hooks there. After this call the app has no
 * models and goes back to the setup wizard.
 */
export function resetAllAppData(): Promise<void> {
  return runReset({
    cancelDownloads: cancelAllDownloads,
    unloadEngines: async () => {
      await Promise.all([llamaEngine.unload(), embeddingEngine.unload()]);
    },
    forgetStores: () => runResetHooks("forget"),
    // The knowledge base (chat history, indexed documents) must be wiped, never skipped.
    wipeDatabase: () => runResetHooks("wipe", ["knowledge-base"]),
    deleteFiles: async () => {
      for (const dir of DATA_DIRS) await FileSystem.deleteAsync(dir, { idempotent: true });
      // Which files passed their sha256 check: nothing left to vouch for.
      await clearVerifiedRecords();
    },
    clearSettings: async () => {
      await clearSettings();
      await clearDiscoveredModels();
    },
  });
}
