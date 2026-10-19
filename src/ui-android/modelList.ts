import type { CatalogModel } from "../models/manifest";

/** Which models the list shows (the native app's ModelOrder.Filter): MINE are the ones added from Hugging Face. */
export type ModelFilter = "all" | "here" | "downloading" | "mine";
export const MODEL_FILTERS: ModelFilter[] = ["all", "here", "downloading", "mine"];

/**
 * Settings › Models, as the native app lists them: answer and embedding models from the catalog, then the ones added
 * from Hugging Face; a hidden catalog model (Phi-3.5-mini) only where it's installed; the active one on top, then
 * downloads in progress, then ready models, the rest in catalog order.
 */
export function listedModels(
  catalog: CatalogModel[],
  discovered: CatalogModel[],
  present: Record<string, boolean>,
  activeIds: Partial<Record<string, string>>,
  downloading: (id: string) => boolean = () => false,
  filter: ModelFilter = "all"
): CatalogModel[] {
  const all = [
    ...catalog.filter((m) => (m.kind === "llm" || m.kind === "embedding") && (!m.hidden || present[m.id])),
    // A search result for a file that's now in the curated catalog would be listed twice.
    ...discovered.filter((d) => !catalog.some((c) => c.filename === d.filename)),
  ];
  const mine = new Set(discovered.map((d) => d.id));
  const shown = all.filter((m) =>
    filter === "here" ? present[m.id] : filter === "downloading" ? downloading(m.id) : filter === "mine" ? mine.has(m.id) : true
  );
  const rank = (m: CatalogModel) => (activeIds[m.kind] === m.id ? 0 : downloading(m.id) ? 1 : present[m.id] ? 2 : 3);
  return shown.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map(({ m }) => m);
}
