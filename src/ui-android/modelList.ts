import type { CatalogModel } from "../models/manifest";

/**
 * Settings › Models, as the native app lists them: answer and embedding models from the catalog, then the ones added
 * from Hugging Face; a hidden catalog model (Phi-3.5-mini) only where it's installed; ready models first, the active
 * one on top, the rest in catalog order.
 */
export function listedModels(
  catalog: CatalogModel[],
  discovered: CatalogModel[],
  present: Record<string, boolean>,
  activeIds: Partial<Record<string, string>>
): CatalogModel[] {
  const all = [
    ...catalog.filter((m) => (m.kind === "llm" || m.kind === "embedding") && (!m.hidden || present[m.id])),
    // A search result for a file that's now in the curated catalog would be listed twice.
    ...discovered.filter((d) => !catalog.some((c) => c.filename === d.filename)),
  ];
  const rank = (m: CatalogModel) => (activeIds[m.kind] === m.id ? 0 : present[m.id] ? 1 : 2);
  return all.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map(({ m }) => m);
}
