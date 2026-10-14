# Places packs (offline restaurants and cafés)

TL;DR: one small SQLite file per region with every named place to eat or drink
from OpenStreetMap (diet tags, cuisine, address, opening hours, coordinates)
plus the Eat/Drink listings of the region's Wikivoyage guides, searched on the
phone by distance and diet. A world gazetteer (GeoNames) resolves city names.
Nothing is generated: every place in an answer is a record with a link to its
source.

```bash
# 1. food and drink POIs of a bounding box (one Overpass query, a few MB)
curl -sf --data-urlencode data@query.overpass https://overpass-api.de/api/interpreter -o osm-sao-paulo.json
# 2. world gazetteer (once): GeoNames cities with 15,000+ people
curl -LO https://download.geonames.org/export/dump/cities15000.zip && unzip cities15000.zip
curl -LO https://download.geonames.org/export/dump/countryInfo.txt
node scripts/build-places-pack.mjs cities15000.txt countryInfo.txt world-places.sqlite
# 3. the region's pack
node scripts/build-poi-pack.mjs --id sao-paulo --name-en "São Paulo" --name-pt "São Paulo" \
  --bbox=-23.80,-46.83,-23.36,-46.36 --tz America/Sao_Paulo --osm osm-sao-paulo.json \
  --voyage enwikivoyage-latest-pages-articles.xml.bz2 --voyage-title "São Paulo" \
  --places world-places.sqlite --out poi/sao-paulo.sqlite
```

The Overpass query (`query.overpass`, replace the bounding box):

```
[out:json][timeout:300];
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|bar|pub|biergarten|ice_cream)$"](-23.80,-46.83,-23.36,-46.36);
  nwr["shop"~"^(bakery|deli|confectionery|pastry)$"](-23.80,-46.83,-23.36,-46.36);
  nwr["diet:vegan"~"^(yes|only|limited)$"](-23.80,-46.83,-23.36,-46.36);
);
out center tags;
```

On the phone the packs live in `<documents>/poi/` (`<region>.sqlite` and
`world-places.sqlite`), opened read-only; nothing is indexed on the device.

## What's in a pack

| Table | Content |
|---|---|
| `pois` | one row per place: OSM ref (`osm:node/123`) or guide listing, lat/lon, grid `cell`, name, category (OSM amenity/shop, or `listing`), cuisine, one column per diet (`vegan`, `vegetarian`, `gluten_free`, `halal`, `kosher`: `only`/`yes`/`limited`/`no`/null), address, opening_hours, phone, website, guide text, `approx` |
| `pois_fts` | FTS5 over name, cuisine, category and guide text (`unicode61 remove_diacritics 2`) |
| `meta` | format `boar-poi-pack` v1, region id and names, bbox, time zones, OSM timestamp, Wikivoyage dump, license, the region's biggest places |

Rules the builder follows:

- A place without a name isn't included: it couldn't be named in an answer.
- A diet comes only from the record: `diet:*` tags, or `cuisine=vegan` /
  `vegetarian` (read as `only`). A missing tag means unknown, never "no", and a
  diet search never returns untagged places.
- Wikivoyage listings keep their own coordinates when the guide has them;
  otherwise they get the article's coordinates and `approx`, and the app shows
  them after the exact places, without a distance. A guide listing matches a
  diet only when its own text mentions it.

**Geographic index.** A 0.01° grid (~1.1 km of latitude) numbered row by row:
the cells of one latitude row are a contiguous range, so a radius query is one
`cell BETWEEN a AND b` per row, then an exact distance check. It needs no
SQLite extension; expo-sqlite doesn't compile R*Tree
(`node_modules/expo-sqlite/android/build.gradle` enables FTS3/4/5 only).

## Search (`src/rag/poiPack.ts`, `src/rag/pois.ts`)

`searchPois({ center, radiusM, diet, categories, text, limit })` (contract in
`src/rag/pois.types.ts`, mirrored by the engine's `src/routing/geo.ts`):

1. Packs whose area contains the center; none → `coverage: "none"` (the app
   says it has no offline data for the place instead of listing somewhere else).
2. Places within 3 km; widened to 10 km, then 25 km, until 3 exact places match.
3. With a diet: tag strength (`only` > `yes` > `limited`), then distance.
   Without: distance. The result states this as `criterion` ("best" means this,
   not popularity, which isn't known offline).

`resolvePlace(name)` looks the name up among GeoNames names and alternate names
(case-insensitive), most populous first.

## Sample build (2026-09-26)

OSM data from Overpass at 2026-09-26 ~20:25 UTC; Wikivoyage dump of 2026-09-01.

| Region | Pack | Named places | diet:vegan | diet:vegetarian | Wikivoyage listings (approx) | Unnamed, dropped |
|---|---|---|---|---|---|---|
| São Paulo | 1.36 MB | 6,870 | 126 | 105 | 143 (35) | 1,131 |
| Singapore | 1.84 MB | 10,018 | 97 | 277 | 171 (45) | 460 |
| Taipei | 3.32 MB | 18,755 | 156 | 407 | 102 (45) | 468 |
| Buenos Aires | 1.47 MB | 7,974 | 78 | 104 | 76 (30) | 418 |
| Berlin | 3.25 MB | 14,984 | 1,979 | 3,437 | 295 (26) | 233 |
| World gazetteer | 20.8 MB | 34,149 places, 366,144 names | | | | |

About 190 bytes per place. SHA-256 of each file is in `src/rag/poiRegions.ts`.

"Vegan places near the city center" on these packs (`searchPois`, diet vegan,
from the city's GeoNames point): São Paulo "Casa da Coxinha Vegana" 78 m, Berlin
"Brammibal's Donuts" 118 m, Singapore "nomVnom Bistro" 378 m, Buenos Aires
"Vegetariana" 834 m, Taipei a tagged place 361 m away; Lisbon → coverage
`none`. Search latency on a desktop, 100 random points in the five areas:
p50 5.7 ms, p95 51 ms (phone: UNKNOWN until measured).

## World size (measured counts, projected size)

Food and drink POIs in OSM (the categories above), from taginfo on 2026-09-26:
world 3,833,916 (`diet:vegan` 67,375, `diet:vegetarian` 117,368). By continent
(Geofabrik's regional taginfo) and projected pack size at ~190 bytes per place,
92% named:

| Continent | POIs | diet:vegan | Projected packs |
|---|---|---|---|
| Europe | 1,715,773 | 47,675 | ~300 MB |
| Asia | 992,066 | 5,781 | ~173 MB |
| North America | 641,770 | 9,992 | ~112 MB |
| South America | 241,568 | 1,649 | ~42 MB |
| Africa | 140,017 | 627 | ~24 MB |
| Australia/Oceania | 75,249 | 1,490 | ~13 MB |
| Central America | 64,130 | 294 | ~11 MB |
| **World** | **~3.87 M** | **~67 k** | **~0.68 GB** + 21 MB gazetteer |

So every region on Earth fits in about 1.4% of the 50 GB budget; per-country
packs (states for the biggest countries) are a few MB to ~60 MB.

## World tiles (built 2026-09-28, measured)

`scripts/build-poi-world.mjs` over every Geofabrik leaf extract (osmium
tags-filter, one extract at a time, deleted after), in slices: the target
cities first, then Europe + the Americas + Asia, then Africa + Oceania.
504 of 512 leaves extracted; the other 8 are 7 groupings whose members are all
leaves (us, us-midwest/northeast/south/west, sea, south-africa-and-lesotho:
~28 GB of downloads skipped, the tiles step dedupes anyway) and enfield
(inside London, served as HTML, not a PBF). About 58 GB of downloads after
Phase 1 (from the servers' Content-Length, not metered), plus 11.5 GB of a
`us` download started by mistake and deleted.

| | Measured |
|---|---|
| Tiles (1°×1°, with named places) | 8,374 |
| Places (OSM + Wikivoyage listings) | 3,490,656 |
| Places tagged vegan | 51,840 |
| All tiles | 0.98 GB (980,279,296 B) |
| Tile size p50 / p95 / max | 36 KB / 404 KB / 9.4 MB (t-N35E139, Tokyo) |
| Gazetteer with the tile index | 22,962,176 B, `215ce466…` |

Hosted on HF `r4topunk/boar-packs`: tiles at commit `44c3375`
(`places/tiles/t-*.sqlite`), gazetteer at `0d75f30`
(`places/world-places.sqlite`, `places/tiles-index.json`). The app downloads
or imports only the tiles around a chosen city (`tilesFor`); the gazetteer's
`tiles` table is the catalog. Diet claims audited with Jev only on the tiles of
the test cities (6,438 places, US$0.026 in total); the rest carry the OSM tag
unaudited.

## Licenses

- OpenStreetMap data: ODbL 1.0, © OpenStreetMap contributors. A pack is a
  derived database: attribution in the app and the pack's `meta.license`.
- Wikivoyage listings: CC BY-SA 4.0, attributed per listing (`source.url`).
- GeoNames: CC BY 4.0.

## Known limits

- OSM tags are community data and can be wrong: in the Taipei sample a burger
  chain carries `diet:vegan=only`. The app shows the record and its source; it
  can't verify it.
- Diet coverage varies a lot: Berlin has 1,979 vegan-tagged places, São Paulo
  126, for similar numbers of restaurants.
- Neighborhood names ("Vila Madalena") aren't in the gazetteer (cities of
  15,000+ only); the engine can fall back to the device position.
- Opening hours are the raw OSM string; the app doesn't evaluate "open now" yet.
