/**
 * Offline places (restaurants, cafés and other food/drink POIs) from
 * OpenStreetMap and Wikivoyage Eat/Drink listings: the contract between the
 * POI packs (src/rag/pois.ts) and the engine (src/routing/geo.ts mirrors it).
 * No native imports.
 *
 * Every Poi is a record from a source; nothing here is generated. A place
 * name shown to the user must come from one of these records.
 */

export type Diet = "vegan" | "vegetarian" | "gluten_free" | "halal" | "kosher";

/** OSM diet:* values ("only" = the whole menu, "limited" = a few options). */
export type DietLevel = "yes" | "only" | "limited" | "no";

export interface Poi {
  /** "osm:node/123", "osm:way/45", or "wikivoyage:<article>#<n>". */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** OSM amenity or shop value: restaurant, cafe, fast_food, bar, pub, bakery, ... ("listing" for Wikivoyage). */
  category: string;
  cuisine: string[];
  /** Only diet tags present in the source; a missing diet means unknown, not "no". */
  diet: Partial<Record<Diet, DietLevel>>;
  address?: string;
  /** Raw OSM opening_hours (or the guide's hours text). */
  openingHours?: string;
  phone?: string;
  website?: string;
  /** Wikivoyage listing text. */
  description?: string;
  /** Coordinates are the article's, not the place's: don't show a distance. */
  approx?: boolean;
  /**
   * Plausibility (0..1) of the record's diet claim, from a build-time check
   * (scripts/audit-poi-diet.mjs), for the diet in `dietCheckFor`. The record
   * itself is unchanged.
   */
  dietCheck?: number;
  dietCheckFor?: Diet;
  /**
   * "verify" when, for the diet asked, the OSM tag looks doubtful (dietCheck
   * < 0.35): listed last, shown as "OSM tag to verify". Otherwise absent, and
   * the place is shown with the single label "vegan according to
   * OpenStreetMap" (Boar, 2026-09-26: no stronger badge).
   */
  dietFlag?: "verify";
  /** When the source data was extracted (OSM replication timestamp or dump date), for attribution. */
  osmDate?: string;
  source: { kind: "osm" | "wikivoyage"; url: string; title?: string };
}

export interface PoiQuery {
  center: { lat: number; lon: number };
  /** Default 3000; widened (10 km, 25 km) when fewer than 3 places match. */
  radiusM?: number;
  diet?: Diet[];
  /** Default: every food and drink category. */
  categories?: string[];
  /** Free terms matched against name and cuisine ("ramen"). */
  text?: string;
  /** Default 10. */
  limit?: number;
}

export interface PoiSearchResult {
  /** Exact places first (diet strength, then distance), then approximate guide listings. */
  pois: (Poi & { distanceM: number })[];
  radiusUsedM: number;
  /**
   * "none": no installed pack covers the point (answer "no offline data for X").
   * "partial": the point is at the edge of a pack's area. "full": inside one.
   */
  coverage: "none" | "partial" | "full";
  /** Id of the pack that answered. */
  region?: string;
  /** How the list is ordered, in words, for "best" questions. */
  criterion: string;
  timingsMs: { search: number };
}

export interface PlaceMatch {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  kind: "city" | "town" | "region";
  population?: number;
}
