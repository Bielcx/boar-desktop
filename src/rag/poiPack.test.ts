/// <reference types="node" />
/**
 * Places packs end to end: a pack built by the real builders from made-up,
 * test-only data (a region "Testville" around 10°N 10°E), searched with the
 * app's code.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSqliteDatabase } from "./testing/nodeSqlite";
import { PoiPack, cellRanges, cleanPlaceName, coverageOf, distanceM, resolvePlaceIn, searchPlacesIn, searchPoiPacks, type PoiArea } from "./poiPack";
import type { PackSql } from "./wikiPack";
import { tileEntry } from "./poiRegions";

const C = { lat: 10, lon: 10 };
// A point `m` meters north of the center.
const north = (m: number) => ({ lat: C.lat + m / 111195, lon: C.lon });
let pack: PoiPack;
let places: PackSql;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "boar-poi-"));
  let id = 1;
  const node = (m: number, tags: Record<string, string>) => ({ type: "node", id: id++, ...north(m), tags });
  const osm = {
    osm3s: { timestamp_osm_base: "2026-09-26T00:00:00Z" },
    elements: [
      node(1000, { amenity: "restaurant", name: "Only Vegan", "diet:vegan": "only", "addr:street": "Main St", "addr:housenumber": "1" }),
      node(500, { amenity: "cafe", name: "Vegan Friendly Cafe", "diet:vegan": "yes", opening_hours: "Mo-Fr 08:00-18:00" }),
      node(200, { amenity: "restaurant", name: "Some Vegan Options", "diet:vegan": "limited" }),
      node(100, { amenity: "restaurant", name: "Steak House" }),
      node(50, { amenity: "restaurant", name: "No Vegan Here", "diet:vegan": "no" }),
      node(300, { amenity: "restaurant", "diet:vegan": "only" }), // no name: not in the pack
      node(8000, { amenity: "restaurant", name: "Far Vegan", cuisine: "vegan" }),
      node(2000, { amenity: "restaurant", name: "Noodle Bar", cuisine: "ramen;japanese" }),
      { type: "way", id: 77, center: north(150), tags: { shop: "bakery", name: "Corner Bakery" } },
      node(120, { amenity: "parking", name: "Car Park" }),
      node(400, { amenity: "fast_food", name: "Burger Chain", brand: "Burger Chain", "diet:vegan": "only" }),
      node(700, { amenity: "restaurant", name: "Unclear Vegan", "diet:vegan": "only" }),
    ],
  };
  const refOf = (name: string) => {
    const e = osm.elements.find((x: any) => x.tags.name === name)!;
    return `osm:${e.type}/${e.id}`;
  };
  writeFileSync(join(dir, "diet-check.json"), JSON.stringify({
    [refOf("Burger Chain")]: { p: 0.2, diet: "vegan", level: "only" },
    [refOf("Unclear Vegan")]: { p: 0.5, diet: "vegan", level: "only" },
    [refOf("Only Vegan")]: { p: 0.93, diet: "vegan", level: "only" },
  }));
  writeFileSync(join(dir, "osm.json"), JSON.stringify(osm));
  const xml = `<mediawiki><page><title>Testville</title><ns>0</ns><id>5</id><revision><text>{{geo|10|10}}
==Eat==
* {{eat|name=Leafy Guide Pick|content=Great vegan dishes.}}
* {{eat|name=Guide Steak|lat=10.001|long=10|content=Meat.}}
</text></revision></page></mediawiki>`;
  writeFileSync(join(dir, "voyage.xml"), xml);
  execFileSync("bzip2", ["-f", join(dir, "voyage.xml")]);
  const city = (id: number, name: string, alt: string, lat: number, lon: number, pop: number, cc: string) =>
    [id, name, name, alt, lat, lon, "P", "PPLC", cc, "", "", "", "", "", pop, "", "", "Etc/UTC", "2026-01-01"].join("\t");
  writeFileSync(join(dir, "cities.txt"), [city(1, "Testville", "Testeville,Tville", 10, 10, 500000, "TV"), city(2, "Otherton", "", 40, 40, 20000, "OT"), city(3, "Testville", "", 50, 50, 16000, "OT")].join("\n"));
  writeFileSync(join(dir, "countries.txt"), "TV\tTVL\t000\tTV\tTestland\nOT\tOTR\t001\tOT\tOtherland\n");
  execFileSync(process.execPath, ["scripts/build-places-pack.mjs", join(dir, "cities.txt"), join(dir, "countries.txt"), join(dir, "places.sqlite")], { stdio: "pipe" });
  execFileSync(process.execPath, [
    "scripts/build-poi-pack.mjs", "--id", "testville", "--name-en", "Testville", "--bbox=9.8,9.8,10.2,10.2", "--tz", "Etc/UTC",
    "--osm", join(dir, "osm.json"), "--voyage", join(dir, "voyage.xml.bz2"), "--voyage-title", "Testville",
    "--places", join(dir, "places.sqlite"), "--diet-check", join(dir, "diet-check.json"), "--out", join(dir, "testville.sqlite"),
  ], { stdio: "pipe" });
  places = nodeSqliteDatabase(join(dir, "places.sqlite"));
  return PoiPack.open(nodeSqliteDatabase(join(dir, "testville.sqlite"))).then((p) => void (pack = p));
}, 60000);

describe("geometry", () => {
  it("measures distances and covers a circle with one cell range per latitude row", () => {
    expect(distanceM(C, north(1000))).toBeCloseTo(1000, -1);
    const ranges = cellRanges(C, 3000);
    expect(ranges.length).toBeGreaterThanOrEqual(5);
    for (const [a, b] of ranges) expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("searchPoiPacks", () => {
  it("orders vegan places by tag strength, then distance, and never lists untagged or 'no' places", async () => {
    const r = await searchPoiPacks([pack], { center: C, diet: ["vegan"] });
    const names = r.pois.map((p) => p.name);
    // "Unclear Vegan" (700 m) and "Only Vegan" (1 km) are both "only": distance decides.
    expect(names.slice(0, 4)).toEqual(["Unclear Vegan", "Only Vegan", "Vegan Friendly Cafe", "Some Vegan Options"]);
    expect(names).not.toContain("Steak House");
    expect(names).not.toContain("No Vegan Here");
    expect(r).toMatchObject({ coverage: "full", region: "testville", radiusUsedM: 3000 });
    expect(r.criterion).toMatch(/diet tag strength.*distance.*popularity isn't known/);
  });

  it("returns source records only: names, OSM links, dates, addresses", async () => {
    const r = await searchPoiPacks([pack], { center: C, diet: ["vegan"] });
    const only = r.pois.find((p) => p.name === "Only Vegan")!;
    expect(only).toMatchObject({
      category: "restaurant",
      diet: { vegan: "only" },
      address: "Main St, 1",
      osmDate: "2026-09-26T00:00:00Z",
      source: { kind: "osm" },
    });
    expect(only.source.url).toMatch(/^https:\/\/www\.openstreetmap\.org\/node\/\d+$/);
    expect(only.distanceM).toBeGreaterThan(950);
    expect(r.pois.every((p) => p.name)).toBe(true);
  });

  it("widens the radius until three places match", async () => {
    const r = await searchPoiPacks([pack], { center: north(6000), diet: ["vegan"] });
    expect(r.radiusUsedM).toBe(10000);
    expect(r.pois.map((p) => p.name)).toContain("Far Vegan");
  });

  it("lists guide listings without their own coordinates after the exact places, marked approximate", async () => {
    const r = await searchPoiPacks([pack], { center: C, diet: ["vegan"] });
    const guide = r.pois.find((p) => p.name === "Leafy Guide Pick")!;
    expect(guide).toMatchObject({ approx: true, source: { kind: "wikivoyage", title: "Testville (Eat)" } });
    // Only places with a doubtful diet tag come after the guide.
    expect(r.pois.slice(r.pois.indexOf(guide) + 1).every((p) => p.dietFlag === "verify")).toBe(true);
    expect(r.pois.slice(0, r.pois.indexOf(guide)).every((p) => !p.approx)).toBe(true);
    expect(r.pois.map((p) => p.name)).not.toContain("Guide Steak");
  });

  it("orders by distance without a diet, food categories only", async () => {
    const r = await searchPoiPacks([pack], { center: C });
    expect(r.pois[0].name).toBe("No Vegan Here");
    expect(r.pois.map((p) => p.name)).toContain("Corner Bakery");
    expect(r.pois.map((p) => p.name)).not.toContain("Car Park");
    expect(r.criterion).toMatch(/^distance/);
  });

  it("matches free text on name and cuisine", async () => {
    const r = await searchPoiPacks([pack], { center: C, text: "ramen" });
    expect(r.pois.map((p) => p.name)).toEqual(["Noodle Bar"]);
  });

  it("says when no pack covers the place, and when the circle crosses the edge", async () => {
    expect(await searchPoiPacks([pack], { center: { lat: 40, lon: 40 } })).toMatchObject({ coverage: "none", pois: [] });
    expect((await searchPoiPacks([pack], { center: { lat: 10.19, lon: 10 } })).coverage).toBe("partial");
  });
});

describe("resolvePlaceIn", () => {
  it("resolves names and alternate names to the most populous match, case-insensitively", async () => {
    expect(await resolvePlaceIn(places, "testville")).toMatchObject({ name: "Testville", lat: 10, lon: 10, country: "Testland", kind: "city" });
    expect(await resolvePlaceIn(places, "Tville")).toMatchObject({ name: "Testville", country: "Testland" });
    expect(await resolvePlaceIn(places, "Otherton")).toMatchObject({ kind: "town" });
    expect(await resolvePlaceIn(places, "Atlantis")).toBeNull();
  });
});

describe("searchPlacesIn", () => {
  it("suggests places by name prefix, alternate names included, most populous first, one row per place", async () => {
    const r = await searchPlacesIn(places, "test");
    expect(r.map((p) => [p.name, p.country])).toEqual([["Testville", "Testland"], ["Testville", "Otherland"]]);
    expect((await searchPlacesIn(places, "tvil")).map((p) => p.name)).toEqual(["Testville"]);
    expect(await searchPlacesIn(places, "zzz")).toEqual([]);
    expect(await searchPlacesIn(places, "  ")).toEqual([]);
  });
});

describe("diet tag audit", () => {
  it("lists a doubtful diet tag last with a verify flag and leaves the others unflagged", async () => {
    const r = await searchPoiPacks([pack], { center: C, diet: ["vegan"] });
    const last = r.pois[r.pois.length - 1];
    expect(last).toMatchObject({ name: "Burger Chain", dietFlag: "verify", dietCheck: 0.2, diet: { vegan: "only" } });
    expect(r.pois.find((p) => p.name === "Unclear Vegan")!.dietFlag).toBeUndefined();
    expect(r.pois.find((p) => p.name === "Only Vegan")!.dietFlag).toBeUndefined();
    expect(r.criterion).toMatch(/doubtful are listed last/);
  });
  it("doesn't flag anything when the diet asked isn't the one checked", async () => {
    const r = await searchPoiPacks([pack], { center: C });
    expect(r.pois.every((p) => !p.dietFlag)).toBe(true);
  });
});

describe("areas (tiles)", () => {
  const area = (id: string, bbox: PoiArea["bbox"], names: string[]): PoiArea => ({
    id,
    bbox,
    within: async (q, r) =>
      names.map((name, i) => ({
        id: `${id}:${i}`, name, lat: bbox[0] + 0.5, lon: bbox[1] + 0.05, category: "restaurant", cuisine: [], diet: {},
        source: { kind: "osm" as const, url: "" }, distanceM: distanceM(q.center, { lat: bbox[0] + 0.5, lon: bbox[1] + 0.05 }),
      })).filter((p) => p.distanceM <= r),
  });

  it("counts coverage over the union of areas, so a neighbouring tile keeps it full", () => {
    const west = area("t-N10E009", [10, 9, 11, 10], []);
    const east = area("t-N10E010", [10, 10, 11, 11], []);
    const edge = { lat: 10.5, lon: 9.999 };
    expect(coverageOf([west], edge, 3000)).toBe("partial");
    expect(coverageOf([west, east], edge, 3000)).toBe("full");
    expect(coverageOf([east], { lat: 12, lon: 12 }, 3000)).toBe("none");
  });

  it("queries a neighbouring tile once the widened circle reaches it", async () => {
    const west = area("t-N10E009", [10, 9, 11, 10], []);
    const east = area("t-N10E010", [10, 10, 11, 11], ["East A", "East B", "East C"]);
    // In the west tile, ~16 km from the east tile's places: out of reach at 3 and 10 km, reached at 25 km.
    const r = await searchPoiPacks([west, east], { center: { lat: 10.5, lon: 9.9 } });
    expect(r.radiusUsedM).toBe(25000);
    expect(r.pois.map((p) => p.name)).toEqual(["East A", "East B", "East C"]);
  });
});

describe("tile index in the gazetteer", () => {
  it("carries each hosted tile's pinned URL to its catalog entry, and none for a tile not hosted yet", () => {
    const d = mkdtempSync(join(tmpdir(), "boar-tiles-"));
    const url = "https://huggingface.co/datasets/r4topunk/boar-packs/resolve/0123456789abcdef0123456789abcdef01234567/places/tiles/t-N41E012.sqlite";
    writeFileSync(join(d, "index.json"), JSON.stringify([
      { id: "t-N41E012", sizeBytes: 100, sha256: "a".repeat(64), pois: 5, vegan: 1, osmDate: "2026-09-25T20:24:36Z", url },
      { id: "t-N42E012", sizeBytes: 50, sha256: "b".repeat(64), pois: 2, vegan: 0, osmDate: "2026-09-25T20:24:36Z" },
    ]));
    writeFileSync(join(d, "cities.txt"), ["1", "Rome", "Rome", "", "41.9", "12.5", "P", "PPLC", "IT", "", "", "", "", "", "2800000", "", "", "Europe/Rome", "2026-01-01"].join("\t"));
    writeFileSync(join(d, "countries.txt"), "IT\tITA\t380\tIT\tItaly\n");
    execFileSync(process.execPath, ["scripts/build-places-pack.mjs", join(d, "cities.txt"), join(d, "countries.txt"), join(d, "places.sqlite"), join(d, "index.json")], { stdio: "pipe" });
    const rows = nodeSqliteDatabase(join(d, "places.sqlite")).raw.prepare("SELECT id, size_bytes AS sizeBytes, sha256, pois, vegan, osm_date AS osmDate, url FROM tiles ORDER BY id").all() as any[];
    const [hosted, pending] = rows.map(({ url: u, ...t }) => tileEntry(u ? { ...t, url: u } : t));
    expect(hosted.sourceUrl).toBe(url);
    expect(pending.sourceUrl).toBe("");
  });
});

describe("place names as questions write them (PL-1)", () => {
  it("strips punctuation and a leading preposition, and splits off a country", () => {
    expect(cleanPlaceName("Berlin?")).toEqual({ name: "Berlin" });
    expect(cleanPlaceName("in Berlin")).toEqual({ name: "Berlin" });
    expect(cleanPlaceName("em São Paulo.")).toEqual({ name: "São Paulo" });
    expect(cleanPlaceName("Berlin, Germany")).toEqual({ name: "Berlin", country: "Germany" });
  });

  it("resolves those forms in the gazetteer, the given country first", async () => {
    expect((await resolvePlaceIn(places, "Testville?"))?.lat).toBe(10);
    expect((await resolvePlaceIn(places, "in Testville"))?.lat).toBe(10);
    // Two places named Testville: the smaller one when its country is named.
    expect((await resolvePlaceIn(places, "Testville, Otherland"))?.lat).toBe(50);
  });

  it("reads a region pack's biggest places, for resolving without the gazetteer", () => {
    expect(pack.meta.cities.map((c) => c.name)).toContain("Testville");
  });
});

