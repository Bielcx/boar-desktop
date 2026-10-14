/**
 * Offline places on the phone: the installed places packs (<documents>/poi/*.sqlite:
 * regions and 1° tiles) and the world gazetteer (<documents>/poi/world-places.sqlite),
 * opened read-only. Answers the engine's resolvePlace / searchPois (contract in
 * pois.types.ts) and the UI's city search and "download this city" (tilesFor).
 */
import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system/legacy";
import type { CatalogModel } from "../models/manifest";
import { onAssetInstalled, registerAssetProvider, unregisterAssetProvider } from "../models/assetRegistry";
import { PoiPack, resolvePlaceIn, searchPlacesIn, searchPoiPacks, type PlaceSuggestion, type PoiArea } from "./poiPack";
import { WORLD_PLACES_ID, tileBbox, tileEntry, tileIdsFor, type PoiTile } from "./poiRegions";
import type { PlaceMatch, PoiQuery, PoiSearchResult } from "./pois.types";
import type { PackSql } from "./wikiPack";
import { guard, type Guarded } from "./guardedDb";
import { registerResetHook } from "../services/resetOrder";

export type { Diet, DietLevel, PlaceMatch, Poi, PoiQuery, PoiSearchResult } from "./pois.types";
export type { PlaceSuggestion } from "./poiPack";

export const POI_DIR = "poi/";
export const PLACES_FILE = "world-places.sqlite";

const opened = new Map<string, PoiPack>();
// Every connection this module opened, guarded (src/rag/guardedDb.ts): closing one waits for the searches running
// on it, and later calls on it reject in JS instead of reaching a closed native connection (RS-1).
const conns = new Map<string, Guarded<SQLite.SQLiteDatabase>>();
const opening = new Map<string, Promise<PoiPack | null>>();
let places: PackSql | null = null;
let placesOpening: Promise<PackSql | null> | null = null;
let tileIndex: Map<string, PoiTile> | null = null;
// Bumped by closeAllPoiPacks(): an open still in progress closes what it opened instead of keeping it.
let generation = 0;

async function open(file: string): Promise<SQLite.SQLiteDatabase> {
  const path = `${FileSystem.documentDirectory}${POI_DIR}${file}`.replace(/^file:\/\//, "");
  const slash = path.lastIndexOf("/");
  const conn = guard(await SQLite.openDatabaseAsync(path.slice(slash + 1), { useNewConnection: true }, path.slice(0, slash)), `places ${file}`);
  conns.get(file)?.retire();
  conns.set(file, conn);
  return conn.db;
}

/** Stops using a connection without closing it natively (expo-sqlite 57 crashes closing an FTS5 connection, RS-1). */
async function closeConn(file: string): Promise<void> {
  const conn = conns.get(file);
  conns.delete(file);
  conn?.retire();
}

/** A tile file (t-*.sqlite) SQLite or PoiPack rejects as corrupt; never a transient error. */
export function isUnreadableTile(file: string, e: unknown): boolean {
  if (!tileBbox(file.replace(/\.sqlite$/, ""))) return false;
  const msg = String((e as any)?.message ?? e);
  return /not a places pack|not a database|malformed|corrupt/i.test(msg);
}

function openPack(file: string): Promise<PoiPack | null> {
  const hit = opened.get(file);
  if (hit) return Promise.resolve(hit);
  let p = opening.get(file);
  if (!p) {
    const started = generation;
    p = (async () => {
      try {
        const pack = await PoiPack.open(await open(file));
        if (generation !== started) {
          await closeConn(file);
          return null;
        }
        opened.set(file, pack);
        return pack;
      } catch (e: any) {
        console.warn(`[pois] ${file} isn't a places pack:`, e?.message ?? e);
        await closeConn(file);
        // A tile that can't be read is deleted, so the area shows as missing and can be fetched again;
        // a tile that merely differs from the tile index is kept (ModelManager keptAcrossIndexUpdates).
        if (isUnreadableTile(file, e)) await FileSystem.deleteAsync(`${FileSystem.documentDirectory}${POI_DIR}${file}`, { idempotent: true }).catch(() => {});
        return null;
      }
    })().finally(() => opening.delete(file));
    opening.set(file, p);
  }
  return p;
}

/**
 * Every installed places pack as a searchable area. A tile's area comes from
 * its file name and the file is opened only when a search reaches it (a
 * continent is hundreds of tiles); a region pack is opened to read its area.
 */
export async function installedPoiAreas(): Promise<PoiArea[]> {
  const names = await FileSystem.readDirectoryAsync(`${FileSystem.documentDirectory}${POI_DIR}`).catch(() => [] as string[]);
  const areas: PoiArea[] = [];
  for (const n of names) {
    if (!n.endsWith(".sqlite") || n === PLACES_FILE) continue;
    const bbox = tileBbox(n.replace(/\.sqlite$/, ""));
    if (bbox) {
      areas.push({
        id: n.replace(/\.sqlite$/, ""),
        bbox,
        within: async (q, r) => (await openPack(n))?.within(q, r) ?? [],
      });
    } else {
      const p = await openPack(n);
      if (p) areas.push(p);
    }
  }
  for (const n of [...opened.keys()]) if (!names.includes(n)) await closePoiPack(n);
  return areas;
}

/** Stops using an open pack before its file is deleted (not closed natively; see closeConn). */
export async function closePoiPack(filename: string): Promise<void> {
  const file = filename.replace(/^.*\//, "");
  opened.delete(file);
  if (file === PLACES_FILE) places = null;
  await closeConn(file);
}

/**
 * Forgets every places pack and the gazetteer (a reset deletes poi/ next), including ones still being opened, and
 * the caches, without closing connections natively. Idempotent; registered with the reset order below.
 */
export async function forgetAllPoiPacks(): Promise<void> {
  generation++;
  await Promise.all([...opening.values(), placesOpening].map((p) => p?.catch(() => null)));
  opened.clear();
  places = null;
  placesOpening = null;
  tileIndex = null;
  await Promise.all([...conns.keys()].map(closeConn));
}

/** @deprecated Kept for callers of the first reset contract. */
export const closeAllPoiPacks = forgetAllPoiPacks;

registerResetHook("forget", "places", forgetAllPoiPacks);

export async function searchPois(q: PoiQuery): Promise<PoiSearchResult> {
  return searchPoiPacks(await installedPoiAreas(), q);
}

function gazetteer(): Promise<PackSql | null> {
  if (places) return Promise.resolve(places);
  if (!placesOpening) {
    const started = generation;
    placesOpening = (async () => {
      const info = await FileSystem.getInfoAsync(`${FileSystem.documentDirectory}${POI_DIR}${PLACES_FILE}`);
      if (!info.exists) return null;
      const db = await open(PLACES_FILE);
      if (generation !== started) {
        await closeConn(PLACES_FILE);
        return null;
      }
      places = db;
      return db;
    })().finally(() => {
      placesOpening = null;
    });
  }
  return placesOpening;
}

/** A city or town by name, from the world gazetteer; null when unknown or the gazetteer isn't installed. */
export async function resolvePlace(name: string): Promise<PlaceMatch | null> {
  // Without the gazetteer this returns null; the one fallback (the places packs' own cities) is the engine's
  // (src/routing/geoWiring.ts cityByName), which cleans the name with the same cleanPlaceName.
  const db = await gazetteer();
  return db ? resolvePlaceIn(db, name) : null;
}

/** City search box: places whose name starts with `query`, most populous first ([] without the gazetteer). */
export async function searchPlaces(query: string, limit = 10): Promise<PlaceSuggestion[]> {
  const db = await gazetteer();
  return db ? searchPlacesIn(db, query, limit) : [];
}

/**
 * The tile index shipped in the gazetteer (sizes and hashes of every tile that
 * has places), loaded once; its entries are then installable by download or
 * file import like any other asset. Called at boot and again whenever the
 * gazetteer is installed. An empty result (no gazetteer yet, or one without the
 * tiles table) is not cached, so a later call reads the gazetteer installed since.
 */
export async function loadTileCatalog(): Promise<Map<string, PoiTile>> {
  if (tileIndex) return tileIndex;
  const db = await gazetteer();
  type Row = { id: string; size_bytes: number; sha256: string; pois: number; vegan: number; osm_date: string; url?: string | null };
  const cols = "id, size_bytes, sha256, pois, vegan, osm_date";
  // Gazetteers built before the tiles were hosted have no url column.
  const rows = db
    ? await db
        .getAllAsync<Row>(`SELECT ${cols}, url FROM tiles`, [])
        .catch(() => db.getAllAsync<Row>(`SELECT ${cols} FROM tiles`, []))
        .catch(() => [] as Row[])
    : [];
  const index = new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, sizeBytes: r.size_bytes, sha256: r.sha256, pois: r.pois, vegan: r.vegan, osmDate: r.osm_date, ...(r.url ? { url: r.url } : {}) },
    ])
  );
  if (!index.size) {
    unregisterAssetProvider("poi-tiles");
    return index;
  }
  const entries = [...index.values()].map(tileEntry);
  registerAssetProvider("poi-tiles", () => entries);
  tileIndex = index;
  return index;
}

/**
 * A newly installed gazetteer (first install, or a new version over the old
 * file) replaces the open connection and the tile index read from it.
 */
export async function reloadTileCatalog(): Promise<Map<string, PoiTile>> {
  await closePoiPack(PLACES_FILE);
  tileIndex = null;
  return loadTileCatalog();
}

// Awaited by the install (a batch import retries the tiles it didn't know once this has registered them).
onAssetInstalled(async (asset) => {
  if (asset.id === WORLD_PLACES_ID) await reloadTileCatalog().catch((e) => console.warn("[pois] tile index reload failed:", e?.message ?? e));
});

/**
 * What to download for a trip: the tiles (that have places) covering a circle
 * around a city, e.g. tilesFor(41.89, 12.48, 15) for Rome.
 */
export async function tilesFor(lat: number, lon: number, radiusKm: number): Promise<CatalogModel[]> {
  const index = await loadTileCatalog();
  return tileIdsFor(lat, lon, radiusKm)
    .map((id) => index.get(id))
    .filter((t): t is PoiTile => !!t)
    .map(tileEntry);
}

/** @deprecated Use installedPoiAreas (kept for callers written against the first contract). */
export const installedPoiPacks = installedPoiAreas;
