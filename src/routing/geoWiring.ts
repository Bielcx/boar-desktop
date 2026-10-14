/**
 * Builds the engine's GeoProviders from the places packs (src/rag/pois.ts)
 * and device location (src/services/location.ts). Pure: the app shell passes
 * the real functions in, tests pass fakes.
 */
import { distanceMeters, GeoProviders } from "./geo";
import { normalizeKey } from "../rag/ptLexicon";
import { ptLexicon } from "../rag/ptLexiconAsset";
import { cleanPlaceName } from "../rag/poiPack";

export interface GeoSources {
  installedPoiPacks(): Promise<unknown[]>;
  getCurrentPoint(opts: { timeoutMs: number }): ReturnType<GeoProviders["getLocation"]>;
  resolvePlace: GeoProviders["resolvePlace"];
  searchPois: GeoProviders["searchPois"];
  /** src/services/location.ts getLocationFix: never a fix older than 5 min as the position. */
  getLocationFix?: NonNullable<GeoProviders["getLocationFix"]>;
  /** Known cities (the places packs' biggest ones), for "your last location was in X". */
  cities?(): Array<{ name: string; lat: number; lon: number; country?: string }>;
}

/** A last fix farther than this from every known city is not named. */
export const NEAREST_CITY_MAX_M = 50_000;

export function geoProvidersFrom(s: GeoSources): GeoProviders {
  return {
    // A failed listing counts as "no pack", so the answer says to install one.
    hasPlaces: async () => (await s.installedPoiPacks().catch(() => [])).length > 0,
    getLocation: ({ timeoutMs }) => s.getCurrentPoint({ timeoutMs }),
    ...(s.getLocationFix ? { getLocationFix: s.getLocationFix } : {}),
    nearestCity: async (p) => {
      let best: { name: string; country?: string } | null = null;
      let bestD = NEAREST_CITY_MAX_M;
      for (const c of s.cities?.() ?? []) {
        const d = distanceMeters(p, c);
        if (d <= bestD) (bestD = d), (best = { name: c.name, ...(c.country ? { country: c.country } : {}) });
      }
      return best;
    },
    // PL-1 (Prism): without the place-names index (world-places.sqlite) the gazetteer resolves
    // nothing, and "vegan restaurants in Berlin" said "no places" while the GPS path, which needs
    // no gazetteer, listed ten. Fall back to the places packs' own cities.
    resolvePlace: async (name) =>
      (await s.resolvePlace(name).catch(() => null)) ??
      cityByName(s.cities?.() ?? [], name) ??
      // A Portuguese name ("Berlim", "Lisboa", "Nova Iorque") through Bramble's PT->EN lexicon; the result
      // still has to be one of the packs' cities, so a wrong translation just finds nothing.
      cityByName(s.cities?.() ?? [], ptLexicon()[normalizeKey(cleanPlaceName(name).name)] ?? ""),
    searchPois: (q) => s.searchPois(q),
  };
}

const fold = (x: string) => x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

/** A packs' city with this name (accents and case ignored), as a place match. */
export function cityByName(
  cities: Array<{ name: string; lat: number; lon: number; country?: string }>,
  name: string
): { name: string; lat: number; lon: number; country?: string; kind: string } | null {
  // Same cleaning as the gazetteer (Bramble's cleanPlaceName): "Berlin?", "in Berlin", "Berlin, Germany".
  const wanted = fold(cleanPlaceName(name).name);
  if (!wanted) return null;
  const c = cities.find((x) => fold(x.name) === wanted);
  return c ? { name: c.name, lat: c.lat, lon: c.lon, ...(c.country ? { country: c.country } : {}), kind: "city" } : null;
}
