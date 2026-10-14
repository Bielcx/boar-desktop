/**
 * Search over offline places packs (scripts/build-poi-pack.mjs) and the world
 * gazetteer (scripts/build-places-pack.mjs), through the PackSql interface so
 * the same code runs on the phone and in tests. No native imports.
 *
 * Nothing is inferred: a place matches a diet only when its record says so
 * (OSM diet:* tags, or cuisine=vegan/vegetarian), and a guide listing matches
 * only when its own text mentions the diet. Places without a name aren't in
 * the packs at all.
 */
import type { PackSql } from "./wikiPack";
import type { Diet, DietLevel, PlaceMatch, Poi, PoiQuery, PoiSearchResult } from "./pois.types";

export const CELL_DEG = 0.01;
const CELLS_PER_ROW = 36000;
const RADII_M = [3000, 10000, 25000];
const MIN_RESULTS = 3;
/** Below this diet_check the OSM diet tag is shown as doubtful (Boar, 2026-09-26). */
export const DIET_DOUBTFUL = 0.35;
const EARTH_M = 6371000;

export const FOOD_CATEGORIES = [
  "restaurant", "cafe", "fast_food", "food_court", "bar", "pub", "biergarten", "ice_cream",
  "bakery", "deli", "confectionery", "pastry", "listing",
];

const DIET_WORDS: Record<Diet, RegExp> = {
  vegan: /\bvegan/i,
  vegetarian: /\bvegetarian/i,
  gluten_free: /\bgluten[- ]?free\b|\bceliac/i,
  halal: /\bhalal\b/i,
  kosher: /\bkosher\b/i,
};
const STRENGTH: Record<DietLevel, number> = { only: 3, yes: 2, limited: 1, no: -1 };

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cell-id ranges (one per 0.01° latitude row) covering a circle: each row's cells are contiguous. */
export function cellRanges(center: { lat: number; lon: number }, radiusM: number): Array<[number, number]> {
  const dLat = (radiusM / EARTH_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos((center.lat * Math.PI) / 180));
  const row = (lat: number) => Math.floor((lat + 90) / CELL_DEG);
  const col = (lon: number) => Math.floor((lon + 180) / CELL_DEG);
  const c0 = Math.max(0, col(center.lon - dLon));
  const c1 = Math.min(CELLS_PER_ROW - 1, col(center.lon + dLon));
  const out: Array<[number, number]> = [];
  for (let r = row(center.lat - dLat); r <= row(center.lat + dLat); r++) out.push([r * CELLS_PER_ROW + c0, r * CELLS_PER_ROW + c1]);
  return out;
}

export interface PoiPackMeta {
  id: string;
  nameEn: string;
  namePt: string;
  bbox: [number, number, number, number];
  osmDate: string;
  voyageDump: string;
  /** The region's biggest places (name and point), for resolving a city by name without the gazetteer. */
  cities: Array<{ name: string; lat: number; lon: number }>;
}

type Row = {
  id: number; ref: string; lat: number; lon: number; name: string; category: string; cuisine: string | null;
  vegan: DietLevel | null; vegetarian: DietLevel | null; gluten_free: DietLevel | null; halal: DietLevel | null; kosher: DietLevel | null;
  address: string | null; opening_hours: string | null; phone: string | null; website: string | null;
  description: string | null; approx: number; source: number; source_title: string | null;
  diet_check?: number | null; diet_check_for?: Diet | null;
};

const DIETS: Diet[] = ["vegan", "vegetarian", "gluten_free", "halal", "kosher"];

function toPoi(r: Row, meta: PoiPackMeta): Poi {
  const diet: Poi["diet"] = {};
  for (const d of DIETS) if (r[d]) diet[d] = r[d]!;
  const osm = r.source === 0;
  const guideTitle = r.source_title?.replace(/ \((Eat|Drink)\)$/, "") ?? "";
  return {
    id: r.ref,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    category: r.category,
    cuisine: r.cuisine ? r.cuisine.split(";") : [],
    diet,
    ...(r.address ? { address: r.address } : {}),
    ...(r.opening_hours ? { openingHours: r.opening_hours } : {}),
    ...(r.phone ? { phone: r.phone } : {}),
    ...(r.website ? { website: r.website } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.approx ? { approx: true } : {}),
    ...(r.diet_check != null ? { dietCheck: r.diet_check, dietCheckFor: r.diet_check_for ?? undefined } : {}),
    osmDate: osm ? meta.osmDate : meta.voyageDump,
    source: osm
      ? { kind: "osm", url: `https://www.openstreetmap.org/${r.ref.slice(4)}` }
      : {
          kind: "wikivoyage",
          url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(guideTitle.replace(/ /g, "_"))}`,
          title: r.source_title ?? undefined,
        },
  };
}

export class PoiPack implements PoiArea {
  private constructor(private db: PackSql, readonly meta: PoiPackMeta) {}

  get id(): string {
    return this.meta.id;
  }

  get bbox(): PoiArea["bbox"] {
    return this.meta.bbox;
  }

  static async open(db: PackSql): Promise<PoiPack> {
    const rows = await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM meta", []);
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m.format !== "boar-poi-pack" || m.formatVersion !== "1") throw new Error("not a places pack");
    return new PoiPack(db, {
      id: m.id,
      nameEn: m.nameEn,
      namePt: m.namePt,
      bbox: JSON.parse(m.bbox),
      osmDate: m.osmDate ?? "",
      voyageDump: m.voyageDump ?? "",
      cities: (() => {
        try {
          return (JSON.parse(m.cities ?? "[]") as Array<{ name: string; lat: number; lon: number }>).map(({ name, lat, lon }) => ({ name, lat, lon }));
        } catch {
          return [];
        }
      })(),
    });
  }

  /** Places within `radiusM` matching the query's categories, diet and text, unsorted. */
  async within(q: PoiQuery, radiusM: number): Promise<Array<Poi & { distanceM: number }>> {
    const ranges = cellRanges(q.center, radiusM);
    const params: any[] = [];
    const where: string[] = [`(${ranges.map(() => "cell BETWEEN ? AND ?").join(" OR ")})`];
    ranges.forEach(([a, b]) => params.push(a, b));
    const cats = q.categories?.length ? q.categories : FOOD_CATEGORIES;
    where.push(`category IN (${cats.map(() => "?").join(",")})`);
    params.push(...cats);
    if (q.text?.trim()) {
      const terms = (q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => `"${t}"*`);
      if (terms.length) {
        where.push("id IN (SELECT rowid FROM pois_fts WHERE pois_fts MATCH ?)");
        params.push(terms.join(" OR "));
      }
    }
    const rows = await this.db.getAllAsync<Row>(`SELECT * FROM pois WHERE ${where.join(" AND ")}`, params);
    const diets = q.diet ?? [];
    const out: Array<Poi & { distanceM: number }> = [];
    for (const r of rows) {
      const d = distanceM(q.center, r);
      if (d > radiusM) continue;
      if (diets.length) {
        const tagged = diets.some((x) => r[x] && r[x] !== "no");
        const mentioned = r.source === 1 && diets.some((x) => DIET_WORDS[x].test(`${r.name} ${r.description ?? ""}`));
        if (!tagged && !mentioned) continue;
      }
      out.push({ ...toPoi(r, this.meta), distanceM: Math.round(d) });
    }
    return out;
  }
}

/** Diet strength of a place for the requested diets (best one), 0 when only mentioned in a guide. */
function strength(p: Poi, diets: Diet[]): number {
  return Math.max(0, ...diets.map((d) => (p.diet[d] ? STRENGTH[p.diet[d]!] : 0)));
}

/**
 * Searches the packs covering the center, widening the radius (3 km → 10 km →
 * 25 km) until at least 3 exact places match. Exact places are ordered by
 * diet strength (only > yes > limited) when a diet was asked, then distance;
 * guide listings without their own coordinates come after them.
 */
/** Anything searchable by area: an open places pack, or a tile that opens its file on first use. */
export interface PoiArea {
  id: string;
  /** [minLat, minLon, maxLat, maxLon] */
  bbox: [number, number, number, number];
  within(q: PoiQuery, radiusM: number): Promise<Array<Poi & { distanceM: number }>>;
}

const EARTH_DEG_M = (Math.PI / 180) * EARTH_M;

/** Bounding box of a circle, in degrees. */
function circleBox(c: { lat: number; lon: number }, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / EARTH_DEG_M;
  const dLon = dLat / Math.max(0.01, Math.cos((c.lat * Math.PI) / 180));
  return [c.lat - dLat, c.lon - dLon, c.lat + dLat, c.lon + dLon];
}

const inside = (b: PoiArea["bbox"], lat: number, lon: number) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
const overlaps = (a: PoiArea["bbox"], b: PoiArea["bbox"]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * "none" when no area contains the center; "full" when the areas together
 * cover the circle (its box's corners and edge midpoints), else "partial".
 */
export function coverageOf(areas: PoiArea[], center: { lat: number; lon: number }, radiusM: number): PoiSearchResult["coverage"] {
  if (!areas.some((a) => inside(a.bbox, center.lat, center.lon))) return "none";
  const [s, w, n, e] = circleBox(center, radiusM);
  const probes = [[s, w], [s, e], [n, w], [n, e], [s, center.lon], [n, center.lon], [center.lat, w], [center.lat, e]];
  return probes.every(([la, lo]) => areas.some((a) => inside(a.bbox, la, lo))) ? "full" : "partial";
}

/**
 * Searches the areas around the center, widening the radius (3 km → 10 km →
 * 25 km) until at least 3 exact places match; each radius queries every area
 * its circle touches (a neighboring tile too). Exact places are ordered by
 * diet strength (only > yes > limited) when a diet was asked, then distance;
 * guide listings without their own coordinates come after them, and places
 * whose diet tag looks doubtful last.
 */
export async function searchPoiPacks(areas: PoiArea[], q: PoiQuery): Promise<PoiSearchResult> {
  const t0 = Date.now();
  const limit = q.limit ?? 10;
  const diets = q.diet ?? [];
  const start = q.radiusM ?? RADII_M[0];
  const radii = [start, ...RADII_M.filter((r) => r > start)];
  const criterion = diets.length
    ? `diet tag strength (${diets.join("/")}: only > yes > limited), then distance; places whose tag looks doubtful are listed last; popularity isn't known offline`
    : "distance; popularity isn't known offline";
  const coverage = coverageOf(areas, q.center, start);
  if (coverage === "none") return { pois: [], radiusUsedM: start, coverage, criterion, timingsMs: { search: Date.now() - t0 } };
  const home = areas
    .filter((a) => inside(a.bbox, q.center.lat, q.center.lon))
    .sort((x, y) => (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]) - (y.bbox[2] - y.bbox[0]) * (y.bbox[3] - y.bbox[1]))[0];

  let found: Array<Poi & { distanceM: number }> = [];
  let radiusUsedM = start;
  for (const r of radii) {
    radiusUsedM = r;
    const box = circleBox(q.center, r);
    found = (await Promise.all(areas.filter((a) => overlaps(a.bbox, box)).map((a) => a.within(q, r)))).flat();
    if (found.filter((p) => !p.approx && !(p.dietCheck != null && p.dietCheck < DIET_DOUBTFUL)).length >= MIN_RESULTS) break;
  }
  const seen = new Set<string>();
  found = found.filter((p) => !seen.has(p.id) && seen.add(p.id));
  // Build-time plausibility of the diet tag (never changes the record): doubtful claims go last, marked.
  for (const p of found) {
    if (p.dietCheck == null || !p.dietCheckFor || !diets.includes(p.dietCheckFor)) continue;
    if (p.dietCheck < DIET_DOUBTFUL) p.dietFlag = "verify";
  }
  const exact = found
    .filter((p) => !p.approx && p.dietFlag !== "verify")
    .sort((a, b) => (diets.length ? strength(b, diets) - strength(a, diets) : 0) || a.distanceM - b.distanceM);
  const doubtful = found.filter((p) => !p.approx && p.dietFlag === "verify").sort((a, b) => a.distanceM - b.distanceM);
  const approx = found.filter((p) => p.approx).sort((a, b) => a.distanceM - b.distanceM);
  return {
    pois: [...exact, ...approx, ...doubtful].slice(0, limit),
    radiusUsedM,
    coverage,
    region: home.id,
    criterion,
    timingsMs: { search: Date.now() - t0 },
  };
}

/** A place name → the most populous gazetteer entry with that name (or alternate name). */
/**
 * A place name as a question writes it, reduced to what the gazetteer stores: no surrounding punctuation, no leading
 * preposition ("in Berlin", "em Lisboa", "near Tokyo"), and a trailing ", Country" split off ("Berlin, Germany").
 */
export function cleanPlaceName(name: string): { name: string; country?: string } {
  let s = name.trim().replace(/\s+/g, " ").replace(/^[\s"'“”‘’(¿¡]+|[\s"'“”‘’).,;:!?]+$/g, "");
  s = s.replace(/^(?:in|at|near|around|em|no|na|perto de|próximo a|proximo a|en|cerca de)\s+/i, "");
  const comma = s.lastIndexOf(",");
  if (comma > 0) return { name: s.slice(0, comma).trim(), country: s.slice(comma + 1).trim() || undefined };
  return { name: s };
}

export async function resolvePlaceIn(db: PackSql, name: string): Promise<PlaceMatch | null> {
  const { name: clean, country } = cleanPlaceName(name);
  if (!clean) return null;
  // With a country given ("Berlin, Germany"), a place in that country first; the biggest otherwise.
  const row = await db.getFirstAsync<{ name: string; lat: number; lon: number; country: string | null; population: number }>(
    `SELECT p.name, p.lat, p.lon, p.country, p.population FROM names n JOIN places p ON p.id = n.place_id
     WHERE n.name = ? COLLATE NOCASE ORDER BY (p.country = ? COLLATE NOCASE) DESC, p.population DESC LIMIT 1`,
    [clean, country ?? ""]
  );
  if (!row) return null;
  return {
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    ...(row.country ? { country: row.country } : {}),
    kind: row.population >= 100000 ? "city" : "town",
    population: row.population,
  };
}

export interface PlaceSuggestion {
  /** GeoNames id. */
  id: number;
  name: string;
  country?: string;
  lat: number;
  lon: number;
  population: number;
}

/**
 * Places whose name or alternate name starts with `query` (case-insensitive),
 * most populous first, one row per place: the city search box ("Rom" → Rome).
 */
export async function searchPlacesIn(db: PackSql, query: string, limit = 10): Promise<PlaceSuggestion[]> {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) return [];
  // A prefix range on the NOCASE index: name >= q AND name < q + U+FFFF.
  const rows = await db.getAllAsync<{ id: number; name: string; country: string | null; lat: number; lon: number; population: number }>(
    `SELECT p.id, p.name, p.country, p.lat, p.lon, p.population FROM places p
     WHERE p.id IN (SELECT place_id FROM names WHERE name >= ? COLLATE NOCASE AND name < ? COLLATE NOCASE)
     ORDER BY p.population DESC LIMIT ?`,
    [q, `${q}￿`, limit]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, ...(r.country ? { country: r.country } : {}), lat: r.lat, lon: r.lon, population: r.population }));
}
