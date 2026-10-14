import * as FileSystem from "expo-file-system/legacy";
import { CatalogModel } from "./manifest";

/**
 * User-added models found via the Hugging Face search (src/services/modelBrowser.ts),
 * persisted separately from the hand-picked MODEL_CATALOG in manifest.ts —
 * these aren't vetted the way the built-in catalog is (no maintainer has run
 * them), so they're kept out of that list and shown in their own "Discovered"
 * section instead.
 */

const PATH = `${FileSystem.documentDirectory}discovered_models.json`;

async function readAll(): Promise<CatalogModel[]> {
  try {
    const info = await FileSystem.getInfoAsync(PATH);
    if (!info.exists) return [];
    return JSON.parse(await FileSystem.readAsStringAsync(PATH));
  } catch {
    return [];
  }
}

async function writeAll(models: CatalogModel[]): Promise<void> {
  await FileSystem.writeAsStringAsync(PATH, JSON.stringify(models));
}

export async function listDiscoveredModels(): Promise<CatalogModel[]> {
  return readAll();
}

export async function addDiscoveredModel(model: CatalogModel): Promise<void> {
  const all = await readAll();
  if (all.some((m) => m.id === model.id)) return;
  await writeAll([...all, model]);
}

export async function removeDiscoveredModel(id: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((m) => m.id !== id));
}

/** Deletes the discovered-models list outright (used by appReset.ts). */
export async function clearDiscoveredModels(): Promise<void> {
  await FileSystem.deleteAsync(PATH, { idempotent: true });
}
