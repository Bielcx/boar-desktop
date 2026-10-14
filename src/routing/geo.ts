/**
 * Geographic questions ("best vegan restaurants in the city I'm in", "onde
 * comer perto de mim"): intent detection and the deterministic answer built
 * from offline POI records (OpenStreetMap + Wikivoyage Eat/Drink, the
 * knowledge layer's pois pack).
 *
 * The answer text is assembled from the records, never generated: no place
 * name can come from a model. "Best" is stated as the criterion actually used
 * (diet tag strength, then distance), since popularity is not known offline.
 *
 * Pure: no native imports. answer.ts runs the flow with injected providers.
 */
import type { RetrievedChunk } from "../rag/retrieve.types";
import type { Place, PlaceDiet } from "./events";

export type Diet = "vegan" | "vegetarian" | "gluten_free" | "halal" | "kosher";

/** Structural mirror of the knowledge layer's Poi (src/rag/pois.types.ts). */
export interface PoiRecord {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  cuisine: string[];
  diet: Partial<Record<Diet, PlaceDiet>>;
  address?: string;
  openingHours?: string;
  phone?: string;
  website?: string;
  description?: string;
  approx?: boolean;
  osmDate?: string;
  /** Plausibility of the diet tag (0..1), checked when the pack was built; only for the requested diet. */
  dietCheck?: number;
  dietCheckFor?: Diet;
  /** "verify": the tag looks wrong (already last in the list); "uncertain": do not present the diet as strong. */
  dietFlag?: "verify" | "uncertain";
  source: { kind: "osm" | "wikivoyage"; url: string; title?: string };
}

export interface PoiSearchResult {
  pois: (PoiRecord & { distanceM: number })[];
  radiusUsedM: number;
  coverage: "none" | "partial" | "full";
  region?: string;
  timingsMs?: { search: number };
}

export interface GeoPoint {
  lat: number;
  lon: number;
  accuracyM?: number;
  ageS?: number;
}

export interface GeoProviders {
  /** Whether any places pack is installed (false → "places pack not installed", not "no data for X"). */
  hasPlaces?(): Promise<boolean>;
  /** Device position; must not prompt for permission (the UI asks in context). */
  getLocation(opts: { timeoutMs: number }): Promise<GeoPoint | { error: "denied" | "unavailable" | "timeout" | "prompt" }>;
  /**
   * Like getLocation, but a fix older than 5 minutes is never returned as
   * the position: it comes back as { error: "stale", last } when no fresh one
   * arrived in time (src/services/location.ts getLocationFix). Optional:
   * without it, getLocation is used and there is no "last location" prompt.
   */
  getLocationFix?(opts: { timeoutMs: number }): Promise<
    GeoPoint | { error: "denied" | "unavailable" | "timeout" | "prompt" } | { error: "stale"; last: GeoPoint & { ageS: number } }
  >;
  /** The best-known city near a point (for "your last location was in X"); null when none is known. */
  nearestCity?(point: { lat: number; lon: number }): Promise<{ name: string; country?: string } | null>;
  resolvePlace(name: string): Promise<{ name: string; lat: number; lon: number; country?: string; kind: string } | null>;
  searchPois(q: {
    center: { lat: number; lon: number };
    radiusM?: number;
    diet?: Diet[];
    categories?: string[];
    text?: string;
    limit?: number;
  }): Promise<PoiSearchResult>;
}

export interface GeoIntent {
  near: { kind: "device" } | { kind: "place"; name: string };
  diet: Diet[];
  /** Free cuisine/dish terms for the POI text search ("ramen", "pizza"). */
  text?: string;
  wantsBest: boolean;
  lang: "en" | "pt";
  /**
   * Possible city names written without a capital or after "de" ("in berlin",
   * "veganos de Roma"), longest first. Only a gazetteer match makes them the
   * place (answer.ts); otherwise the device location is used.
   */
  placeCandidates?: string[];
}

const DIET_PATTERNS: [Diet, RegExp][] = [
  ["vegan", /\bvegan[oa]?s?\b/i],
  ["vegetarian", /\bvegetarian[oa]?s?\b/i],
  ["gluten_free", /\bgluten[- ]?free\b|\bsem gl[uú]ten\b|\bcel[ií]ac/i],
  ["halal", /\bhalal\b/i],
  ["kosher", /\bkosher\b/i],
];

// Words that name a PLACE to eat: enough on their own.
const FOOD_PLACE =
  /\b(restaurants?|restaurantes?|caf[eé]s|cafeterias?|coffee shops?|bars|pubs?|bakery|bakeries|padarias?|lanchonetes?|pizzarias?|bistros?|diners?|food (courts?|trucks?|stalls?)|where (can|could|should) (i|we) eat|places? to eat|onde comer|lugar(es)? para comer)\b/i;
// Generic food words: only a places question with a location or diet ("vegan food near me"), never alone
// ("What food did the Romans eat?").
const FOOD =
  /\b(food|comida|eat|eating|comer|coffee|breakfast|brunch|lunch|dinner|almo[cç]o|jantar|snack|pizzas?|sushi|ramen|burgers?|hamb[uú]rguer|tacos?|dumplings?|noodles?|street food)\b/i;
const EXPLANATORY = /^(why|how|what (is|are|was|were|did|does)|when|who|explain|describe|history|por ?que|como|o que|quando|quem|explique)\b/i;

const CUSTOMS =
  /(?<![\p{L}])(tip|tips|tipping|gorjetas?|etiquette|etiqueta|customs?|costumes?|manners|dress code|smok\w*|fumar|expected|esperad[oa]s?|allowed|permitid[oa]s?|obrigat[óo]ri[oa]|mandatory|service charge|taxa de servi[çc]o|cash|dinheiro|cart[ãa]o|credit cards?|reserv\w*|split the bill|dividir a conta)(?![\p{L}])/iu;
const LIST_REQUEST = /\b(best|top|where|recommend\w*|suggest\w*|list|melhor(es)?|onde|recomend\w*|sugir\w*|sugest\w*|lista)\b/i;

const CUISINE_TERMS =
  /\b(pizza|sushi|ramen|burger|hamb[uú]rguer|tacos?|dumplings?|noodles?|thai|indian|indiana|japanese|japonesa|chinese|chinesa|italian|italiana|mexican|mexicana|korean|coreana|vietnamese|ethiopian|brunch|breakfast|bakery|padaria|coffee|caf[eé])\b/gi;

const NEAR_DEVICE =
  /\b(near me|nearby|near here|around me|around here|close to me|close by|in my area|where i am|i am (currently )?in|i'm (currently )?in|city i am|city i'm|my city|my location|perto de mim|aqui perto|por aqui|perto daqui|pr[oó]ximo de mim|na minha cidade|onde estou|onde eu estou)\b/i;

// "in Lisbon", "em São Paulo", "no Rio de Janeiro", "at Kreuzberg". Capitalized place names only.
const IN_PLACE =
  /\b(?:in|at|around|em|no|na|nos|nas|perto do|perto da)\s+((?:[A-ZÀ-Ý][\p{L}'’.-]*)(?:\s+(?:de|da|do|dos|das|del|la|los|am|an|der|[A-ZÀ-Ý][\p{L}'’.-]*))*)/u;

// With a diet, these nouns mean places to eat ("best vegan places in Tokyo"); alone they don't ("historic places in Rome").
const DIET_PLACE_NOUN = /\b(places?|spots?|options|eater(y|ies)|joints?|lugares?|op[cç][oõ]es|s[ií]tios?)\b/i;

// Any-case place phrase after a preposition, checked against the gazetteer before it is used.
const PLACE_PHRASE = /\b(?:in|at|around|em|no|na|nos|nas|de|da|do|dos|das)\s+([^,.;:!?()[\]]+)/giu;
const NOT_A_PLACE = new Set(
  "the a an my your our his her their this that these those here there town city area country world me us it i o um uma os as meu minha seu sua nosso nossa este esta esse essa aqui ali cidade rua casa comida lugar lugares restaurante restaurantes perto frente downtown center centre centro central asia europe africa america americas oceania".split(" ")
);
const MAX_PLACE_WORDS = 4;

function placeCandidates(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(PLACE_PHRASE)) {
    const words = m[1].trim().split(/\s+/).slice(0, MAX_PLACE_WORDS);
    if (!words.length || NOT_A_PLACE.has(words[0].toLowerCase())) continue;
    for (let n = words.length; n >= 1; n--) {
      const last = words[n - 1].toLowerCase();
      if (/^(de|da|do|of|and|e|the|in|em)$/.test(last)) continue;
      const c = words.slice(0, n).join(" ");
      if (c.length >= 3 && !out.includes(c)) out.push(c);
    }
  }
  return out.sort((a, b) => b.split(" ").length - a.split(" ").length);
}

const PT_HINT = /\b(onde|comer|comida|restaurantes?|perto|melhores?|vegan[oa]s?|vegetarian[oa]s?|cidade|estou|padaria|almo[cç]o|jantar)\b/i;

/**
 * Null unless the question asks for places to eat/drink. The location is the
 * city named in the question when there is one ("in Lisbon"), otherwise the
 * device (explicit "near me" or no location at all: a traveler asking "best
 * vegan restaurants" means here).
 */
export function detectGeoIntent(query: string): GeoIntent | null {
  const q = query.trim();
  const diet = DIET_PATTERNS.filter(([, re]) => re.test(q)).map(([d]) => d);
  const nearDevice = NEAR_DEVICE.test(q);
  const capital = nearDevice ? null : q.match(IN_PLACE)?.[1]?.replace(/[.?!,;:]+$/, "").trim();
  const namedPlace = !!capital && !/^(the|a|an|o|a|um|uma)$/i.test(capital);
  const candidates = nearDevice || namedPlace ? [] : placeCandidates(q);
  const placeWord = FOOD_PLACE.test(q);
  const located = nearDevice || namedPlace || candidates.length > 0;
  const isPlaces =
    (placeWord && !(EXPLANATORY.test(q) && !located)) ||
    (FOOD.test(q) && !EXPLANATORY.test(q) && (located || diet.length > 0)) ||
    // "vegan near me": a diet plus a location is a places question even without a food word.
    (diet.length > 0 && nearDevice) ||
    // "best vegan places in Tokyo", "vegan spots": a diet plus a place noun.
    (diet.length > 0 && DIET_PLACE_NOUN.test(q));
  if (!isPlaces) return null;
  // A question about customs at restaurants ("Is tipping expected in restaurants in Portugal?", Sextant trv-009)
  // asks for knowledge, not for places; unless it also asks for a list or a recommendation.
  if (CUSTOMS.test(q) && !LIST_REQUEST.test(q)) return null;

  const near: GeoIntent["near"] = namedPlace ? { kind: "place", name: capital! } : { kind: "device" };
  const cuisine = [...new Set((q.match(CUISINE_TERMS) ?? []).map((t) => t.toLowerCase()))];
  return {
    near,
    diet,
    text: cuisine.length ? cuisine.join(" ") : undefined,
    wantsBest: /\b(best|top|good|great|melhor(es)?|bons|boas)\b/i.test(q),
    lang: PT_HINT.test(q) ? "pt" : "en",
    ...(candidates.length ? { placeCandidates: candidates } : {}),
  };
}

/** Great-circle distance in meters. */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Same place when two records share a normalized name and lie closer than this (an OSM node and its building, overlapping tiles). */
export const DUPLICATE_PLACE_RADIUS_M = 50;

/** "The Conscious Kitchen" / "Conscious Kitchen, The" / "the conscious-kitchen" -> "conscious kitchen". */
export function normalizePlaceName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^(?:the|o|a|os|as|le|la|les|el|los|las|il|lo|der|die|das) (?=\S)|,? (?:the)$/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * One record per real place: a later record with the same normalized name within DUPLICATE_PLACE_RADIUS_M of a kept
 * one is dropped ("The Conscious Kitchen" twice in Cape Town). Order is kept (the pack's ranking); the kept record
 * takes the address, hours, phone and website it lacks from its duplicate.
 */
export function dedupPlaces<T extends PoiRecord>(pois: T[]): T[] {
  const kept: { p: T; key: string }[] = [];
  for (const p of pois) {
    const key = normalizePlaceName(p.name);
    const twin = key ? kept.find((k) => k.key === key && distanceMeters(k.p, p) < DUPLICATE_PLACE_RADIUS_M) : undefined;
    if (!twin) {
      kept.push({ p, key });
      continue;
    }
    const fill: Partial<PoiRecord> = {};
    for (const f of ["address", "openingHours", "phone", "website"] as const) if (!twin.p[f] && p[f]) fill[f] = p[f];
    if (Object.keys(fill).length) twin.p = { ...twin.p, ...fill };
  }
  return kept.map((k) => k.p);
}

export function toPlace(p: PoiRecord & { distanceM?: number }, sourceIndex: number, withDistance: boolean): Place {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    kind: p.category,
    cuisine: p.cuisine.length ? p.cuisine : undefined,
    diet: Object.keys(p.diet).length ? p.diet : undefined,
    distanceM: withDistance && !p.approx ? p.distanceM : undefined,
    address: p.address,
    openingHours: p.openingHours,
    phone: p.phone,
    website: p.website,
    description: p.description,
    source: p.source.kind,
    sourceIndex,
    dietFlag: p.dietFlag,
  };
}

/** A POI as a citable source, so "[n]" and the source footer work like any other answer. */
export function toSourceChunk(p: PoiRecord): RetrievedChunk {
  const facts = [
    p.address,
    p.cuisine.length ? `Cuisine: ${p.cuisine.join(", ")}` : undefined,
    Object.entries(p.diet)
      .map(([d, v]) => `diet:${d}=${v}`)
      .join(", ") || undefined,
    p.openingHours ? `Hours: ${p.openingHours}` : undefined,
    p.description,
  ].filter(Boolean);
  const origin = p.source.kind === "osm" ? `OpenStreetMap${p.osmDate ? ` (extract ${p.osmDate})` : ""}` : `Wikivoyage${p.source.title ? `: ${p.source.title}` : ""}`;
  return {
    chunkId: p.id,
    docId: p.id,
    title: p.name,
    body: `${facts.join(". ")}. Source: ${origin}, ${p.source.url}`,
    source: p.source.url,
    score: 1,
    matchType: "lexical",
  };
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

const DIET_LABEL: Record<"en" | "pt", Record<Diet, string>> = {
  en: { vegan: "vegan", vegetarian: "vegetarian", gluten_free: "gluten-free", halal: "halal", kosher: "kosher" },
  pt: { vegan: "vegano", vegetarian: "vegetariano", gluten_free: "sem glúten", halal: "halal", kosher: "kosher" },
};
const LEVEL_LABEL: Record<"en" | "pt", Record<PlaceDiet, string>> = {
  en: { only: "only", yes: "options", limited: "limited options", no: "none" },
  pt: { only: "exclusivo", yes: "tem opções", limited: "opções limitadas", no: "não" },
};

export interface PlacesAnswerInput {
  intent: GeoIntent;
  places: Place[];
  /** "near you" or the city name. */
  areaLabel: string;
  byDistance: boolean;
  radiusM?: number;
  /** OpenStreetMap extract date, for the provenance line. */
  osmDate?: string;
}

/** Text answer (also what screen readers and "copy" get). Every name comes from `places`. */
export function formatPlacesAnswer({ intent, places, areaLabel, byDistance, radiusM, osmDate }: PlacesAnswerInput): string {
  const pt = intent.lang === "pt";
  const L = pt ? "pt" : "en";
  const dietWords = intent.diet.map((d) => DIET_LABEL[L][d]).join(pt ? " e " : " and ");
  const listed = places.filter((p) => p.source === "osm" || p.distanceM !== undefined);
  const guide = places.filter((p) => !listed.includes(p));

  const what = pt ? `Lugares${dietWords ? ` com opção ${dietWords}` : " para comer"}` : `${dietWords ? `${dietWords[0].toUpperCase()}${dietWords.slice(1)} places` : "Places to eat"}`;
  const where = byDistance ? (pt ? "perto de você" : "near you") : pt ? `em ${areaLabel}` : `in ${areaLabel}`;
  const order = intent.diet.length
    ? byDistance
      ? pt
        ? `ordenados pela etiqueta de dieta do OpenStreetMap (exclusivo > tem opções > limitadas) e depois pela distância`
        : `ranked by the OpenStreetMap diet tag (only > options > limited), then distance`
      : pt
        ? `ordenados pela etiqueta de dieta do OpenStreetMap (exclusivo > tem opções > limitadas)`
        : `ranked by the OpenStreetMap diet tag (only > options > limited)`
    : byDistance
      ? pt
        ? "do mais perto ao mais longe"
        : "closest first"
      : pt
        ? "na ordem do registro"
        : "in record order";
  const lines: string[] = [`${what} ${where}, ${order}:`];

  listed.forEach((p, i) => {
    const parts = [p.name];
    if (p.distanceM !== undefined) parts.push(formatDistance(p.distanceM));
    if (p.address) parts.push(p.address);
    const d = intent.diet
      .map((k) => {
        if (!p.diet?.[k]) return undefined;
        // A doubtful tag never gets the strong label: "verify" says so, "uncertain" shows the tag without its level.
        if (p.dietFlag === "verify") return pt ? `etiqueta ${DIET_LABEL[L][k]} do OSM a conferir` : `OSM ${DIET_LABEL[L][k]} tag to verify`;
        if (p.dietFlag === "uncertain") return pt ? `etiqueta ${DIET_LABEL[L][k]} (não confirmada)` : `${DIET_LABEL[L][k]} tag (unconfirmed)`;
        return `${DIET_LABEL[L][k]}: ${LEVEL_LABEL[L][p.diet[k]!]}`;
      })
      .filter(Boolean);
    if (d.length) parts.push(d.join(", "));
    if (p.openingHours) parts.push(p.openingHours);
    lines.push(`${i + 1}. ${parts.join(" — ")} [${(p.sourceIndex ?? i) + 1}]`);
  });
  if (guide.length) {
    lines.push("", pt ? "Do guia Wikivoyage (localização aproximada):" : "From the Wikivoyage guide (approximate location):");
    for (const p of guide) lines.push(`- ${p.name}${p.description ? `: ${p.description}` : ""} [${(p.sourceIndex ?? 0) + 1}]`);
  }
  if (intent.wantsBest) {
    lines.push(
      "",
      pt
        ? "\"Melhores\" aqui segue o critério acima; avaliações e popularidade não estão disponíveis offline."
        : "\"Best\" here means the ranking above; ratings and popularity are not available offline."
    );
  }
  if (radiusM && byDistance) lines.push(pt ? `Raio da busca: ${formatDistance(radiusM)}.` : `Search radius: ${formatDistance(radiusM)}.`);
  if (listed.length) {
    lines.push(
      pt
        ? `Dados do OpenStreetMap${osmDate ? ` (extrato de ${osmDate})` : ""}, mantidos por voluntários: etiquetas e horários podem estar errados; confira a fonte numerada.`
        : `Data from OpenStreetMap${osmDate ? ` (extract ${osmDate})` : ""}, maintained by volunteers: tags and hours can be wrong; check the numbered source.`
    );
  }
  return lines.join("\n");
}

/** No installed map covers the area. `city` null = around the device ("near you", never a pack or tile id). */
export function noDataAnswer(intent: GeoIntent, city: string | null): string {
  if (intent.lang === "pt") {
    return `Não tenho dados offline de lugares ${city ? `em ${city}` : "perto de você"}, então não vou listar restaurantes para não inventar.`;
  }
  return `I don't have offline place data ${city ? `for ${city}` : "near you"}, so I won't list any restaurants rather than guess.`;
}

/**
 * A map covers the area but no record matches the filter within the widest
 * radius searched: the data exists, so never "no data" (T2-6).
 */
export function noMatchAnswer(intent: GeoIntent, city: string | null, radiusM: number): string {
  const pt = intent.lang === "pt";
  const L = pt ? "pt" : "en";
  const diet = intent.diet.map((d) => DIET_LABEL[L][d]).join(pt ? " ou " : " or ");
  const text = intent.text?.trim();
  const radius = formatDistance(radiusM);
  // Every filter the search applied is named: "no place tagged kosher" alone would be false when kosher places
  // exist and only the dish is missing (Sextant, "kosher ramen in Rome").
  if (pt) {
    const what =
      diet && text
        ? `nenhum lugar marcado como ${diet} com "${text}"`
        : diet
          ? `nenhum lugar marcado como ${diet}`
          : text
            ? `nenhum lugar com "${text}"`
            : "nenhum lugar para comer registrado";
    return `O mapa offline ${city ? `de ${city}` : "perto de você"} não tem ${what} num raio de ${radius}, então não vou listar nenhum para não inventar.`;
  }
  const what =
    diet && text
      ? `no place tagged ${diet} that matches "${text}"`
      : diet
        ? `no place tagged ${diet}`
        : text
          ? `no place matching "${text}"`
          : "no place to eat or drink recorded";
  return `The offline map ${city ? `for ${city}` : "near you"} has ${what} within ${radius}, so I won't list any rather than guess.`;
}

export function needsPlaceAnswer(intent: GeoIntent): string {
  return intent.lang === "pt"
    ? "Não consegui sua localização (permissão negada ou GPS indisponível). Em que cidade você está?"
    : "I couldn't get your location (permission denied or GPS unavailable). Which city are you in?";
}

/** No fresh fix, only an old one: name it and ask, never list it by itself. */
export function staleLocationAnswer(intent: GeoIntent, city: string | null, ageS: number): string {
  const min = Math.max(1, Math.round(ageS / 60));
  if (intent.lang === "pt") {
    return city
      ? `Não consegui uma localização atual. A última foi em ${city}, há ${min} min. Você ainda está lá, ou em que cidade está?`
      : `Não consegui uma localização atual (a última tem ${min} min). Em que cidade você está?`;
  }
  return city
    ? `I couldn't get a current location. The last one was in ${city}, ${min} min ago. Are you still there, or which city are you in?`
    : `I couldn't get a current location (the last one is ${min} min old). Which city are you in?`;
}

export function noPackAnswer(intent: GeoIntent): string {
  return intent.lang === "pt"
    ? "O pacote offline de lugares não está instalado. Instale-o em Base de conhecimento para buscar restaurantes."
    : "The offline places pack is not installed. Install it from Knowledge Base to search restaurants.";
}
