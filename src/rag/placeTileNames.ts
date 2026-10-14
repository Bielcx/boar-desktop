/** Which city each installed places tile was downloaded for, to name the tiles in the library. */
import type { CatalogModel } from "../models/manifest";
import { getPlaceTileNames, setPlaceTileNames } from "../models/settings";
import { tileBbox } from "./poiRegions";

/** "t-N41E012" from a tile's catalog entry (id "poi-t-N41E012"); null for anything else. */
export function tileIdOf(entry: Pick<CatalogModel, "id">): string | null {
  const id = entry.id.replace(/^poi-/, "");
  return tileBbox(id) ? id : null;
}

/** Which city each installed tile was downloaded for. */
export const placeTileNames = getPlaceTileNames;

/** Remembers the city a set of tiles is for (the gazetteer and other assets are skipped). */
export async function nameTilesAfter(city: string, assets: CatalogModel[]): Promise<void> {
  const ids = assets.map(tileIdOf).filter((id): id is string => !!id);
  if (ids.length > 0) await setPlaceTileNames(Object.fromEntries(ids.map((id) => [id, city])));
}

/** Forgets the names of removed tiles. */
export async function forgetTileNames(tileIds: string[]): Promise<void> {
  if (tileIds.length > 0) await setPlaceTileNames(Object.fromEntries(tileIds.map((id) => [id, null])));
}
