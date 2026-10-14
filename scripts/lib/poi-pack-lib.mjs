// Pure helpers for scripts/build-poi-pack.mjs (no I/O), tested in poi-pack-lib.test.mjs.

/** Grid cell of 0.01° (~1.1 km of latitude): row-major, so one latitude row is a contiguous id range. */
export const CELL_DEG = 0.01;
export const CELLS_PER_ROW = 36000;
export function cellOf(lat, lon) {
  return Math.floor((lat + 90) / CELL_DEG) * CELLS_PER_ROW + Math.floor((lon + 180) / CELL_DEG);
}

const DIETS = ["vegan", "vegetarian", "gluten_free", "halal", "kosher"];
const LEVELS = new Set(["yes", "only", "limited", "no"]);

/** diet:* tags → {vegan: "only", ...}; cuisine=vegan/vegetarian count as "only" (the place is defined by it). */
export function dietOf(tags) {
  const out = {};
  for (const d of DIETS) {
    const v = String(tags[`diet:${d}`] ?? "").toLowerCase().trim();
    if (LEVELS.has(v)) out[d] = v;
  }
  const cuisines = cuisinesOf(tags);
  if (cuisines.includes("vegan") && !out.vegan) out.vegan = "only";
  if (cuisines.includes("vegetarian") && !out.vegetarian) out.vegetarian = "only";
  return out;
}

export function cuisinesOf(tags) {
  return String(tags.cuisine ?? "")
    .split(/[;,]/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

/** "Rua Augusta, 1500 - Consolação, São Paulo" from addr:* tags; null without a street. */
export function addressOf(tags) {
  const street = tags["addr:street"];
  if (!street) return tags["addr:full"] ?? null;
  const first = tags["addr:housenumber"] ? `${street}, ${tags["addr:housenumber"]}` : street;
  const area = tags["addr:suburb"] ?? tags["addr:neighbourhood"] ?? tags["addr:district"];
  const city = tags["addr:city"];
  return [first, area, city].filter(Boolean).join(", ");
}

/** Category of an OSM element: amenity, else shop. */
export function categoryOf(tags) {
  return String(tags.amenity ?? tags.shop ?? "food").split(";")[0].trim();
}

// ---- Wikivoyage Eat/Drink listings ----

const LISTING_TYPES = new Set(["eat", "drink", "listing"]);

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; ) {
    const two = s.slice(i, i + 2);
    if (two === "{{" || two === "[[") (depth++, (cur += two), (i += 2));
    else if (two === "}}" || two === "]]") (depth--, (cur += two), (i += 2));
    else if (s[i] === "|" && depth === 0) (parts.push(cur), (cur = ""), i++);
    else cur += s[i++];
  }
  parts.push(cur);
  return parts;
}

function clean(s) {
  return String(s ?? "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Listings in the Eat and Drink sections of a Wikivoyage page's wikitext:
 * {{eat|name=…|lat=…|long=…|address=…|hours=…|price=…|content=…}} and
 * {{listing|…}} under those headings. Section = "Eat" or "Drink".
 */
export function voyageListings(wikitext) {
  const out = [];
  let section = null;
  const lines = wikitext.split("\n");
  let buf = null;
  let depth = 0;
  for (const line of lines) {
    const h = line.match(/^(={2,3})\s*(.*?)\s*=+\s*$/);
    if (h && buf === null) {
      if (h[1].length === 2) section = /^eat$/i.test(h[2]) ? "Eat" : /^drink$/i.test(h[2]) ? "Drink" : null;
      continue;
    }
    if (!section) continue;
    // gather a template that may span several lines
    let i = 0;
    while (i < line.length) {
      if (buf === null) {
        const at = line.indexOf("{{", i);
        if (at < 0) break;
        buf = "";
        depth = 0;
        i = at;
      }
      const two = line.slice(i, i + 2);
      if (two === "{{") (depth++, (buf += two), (i += 2));
      else if (two === "}}") {
        depth--;
        buf += two;
        i += 2;
        if (depth === 0) {
          const l = parseListing(buf.slice(2, -2), section);
          if (l) out.push(l);
          buf = null;
        }
      } else buf += line[i++];
    }
    if (buf !== null) buf += "\n";
  }
  return out;
}

function parseListing(body, section) {
  const parts = splitTop(body);
  const type = parts[0].trim().toLowerCase();
  if (!LISTING_TYPES.has(type)) return null;
  const f = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) f[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  const name = clean(f.name);
  if (!name) return null;
  const lat = Number(f.lat);
  const lon = Number(f.long ?? f.lon);
  const ok = f.lat && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    section,
    name,
    lat: ok ? lat : null,
    lon: ok ? lon : null,
    address: clean(f.address) || null,
    hours: clean(f.hours) || null,
    price: clean(f.price) || null,
    phone: clean(f.phone) || null,
    url: f.url?.trim() || null,
    content: clean(f.content) || null,
  };
}

// ---- 1°×1° tiles ----

/** [lat, lon] of the south-west corner of the 1° tile containing a point. */
export function tileOf(lat, lon) {
  return [Math.floor(lat), Math.floor(lon)];
}

/** "t-N41E012" for the tile whose south-west corner is 41°N 12°E ("t-S24W047" for -24, -47). */
export function tileId(lat, lon) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `t-${ns}${String(Math.abs(lat)).padStart(2, "0")}${ew}${String(Math.abs(lon)).padStart(3, "0")}`;
}
