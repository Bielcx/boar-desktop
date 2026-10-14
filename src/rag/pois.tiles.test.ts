import { beforeEach, describe, expect, it, vi } from "vitest";

// The gazetteer on "disk": absent until a test installs it, with or without tile rows.
const disk = { gazetteer: false, tiles: [] as Array<Record<string, unknown>> };
const opens: string[] = [];

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: async (uri: string) => ({ exists: uri.endsWith("world-places.sqlite") && disk.gazetteer }),
  readDirectoryAsync: async () => [],
}));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async (name: string) => {
    opens.push(name);
    const rows = disk.tiles.slice();
    return {
      getAllAsync: async (sql: string) => (sql.includes("FROM tiles") ? rows : []),
      getFirstAsync: async () => null,
      closeAsync: async () => {},
    };
  },
}));

import { forgetAllPoiPacks, loadTileCatalog } from "./pois";
import { findAsset, notifyAssetInstalled } from "../models/assetRegistry";
import { WORLD_PLACES_ID, worldPlacesEntry } from "./poiRegions";

const tile = { id: "t-N41E012", size_bytes: 1234, sha256: "a".repeat(64), pois: 900, vegan: 40, osm_date: "2026-09-26", url: "https://example/t-N41E012.sqlite" };
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await forgetAllPoiPacks();
  disk.gazetteer = false;
  disk.tiles = [];
  opens.length = 0;
});

describe("tile catalog", () => {
  it("does not cache an empty index read before the gazetteer is installed", async () => {
    expect((await loadTileCatalog()).size).toBe(0);
    disk.gazetteer = true;
    disk.tiles = [tile];
    const index = await loadTileCatalog();
    expect(index.get("t-N41E012")?.sha256).toBe(tile.sha256);
  });

  it("registers the tiles as installable assets once loaded", async () => {
    disk.gazetteer = true;
    disk.tiles = [tile];
    await loadTileCatalog();
    const { tileEntry } = await import("./poiRegions");
    const id = tileEntry({ id: "t-N41E012", sizeBytes: 1234, sha256: tile.sha256, pois: 900, vegan: 40, osmDate: "2026-09-26" }).id;
    expect(findAsset(id)?.sha256).toBe(tile.sha256);
  });

  it("reopens the gazetteer and rereads the index when a new gazetteer is installed", async () => {
    disk.gazetteer = true;
    disk.tiles = [];
    expect((await loadTileCatalog()).size).toBe(0);
    disk.tiles = [tile]; // a newer gazetteer, with the tiles table, replaces the file
    notifyAssetInstalled(worldPlacesEntry());
    await settle();
    await settle();
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect((await loadTileCatalog()).has("t-N41E012")).toBe(true);
    expect(worldPlacesEntry().id).toBe(WORLD_PLACES_ID);
  });
});
