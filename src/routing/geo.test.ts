import { describe, it, expect, beforeEach } from "vitest";
import { dedupPlaces, detectGeoIntent, formatDistance, GeoProviders, noMatchAnswer, normalizePlaceName, PoiRecord } from "./geo";
import { createAnswerer, AnswerDeps, DEVICE_INSIDE_TIMEOUT_MS, LOCATING_SIGNAL_MS } from "./answer";
import type { AnswerEvent } from "./events";

describe("detectGeoIntent", () => {
  it("reads Vitalik's literal test as a device-location vegan search", () => {
    const i = detectGeoIntent("Tell me the best vegan restaurants in the city I am currently in")!;
    expect(i).toMatchObject({ near: { kind: "device" }, diet: ["vegan"], wantsBest: true, lang: "en" });
  });

  it("uses a named city", () => {
    expect(detectGeoIntent("best vegan restaurants in Lisbon")!.near).toEqual({ kind: "place", name: "Lisbon" });
    expect(detectGeoIntent("Onde comer comida vegana em São Paulo?")!).toMatchObject({
      near: { kind: "place", name: "São Paulo" },
      diet: ["vegan"],
      lang: "pt",
    });
    expect(detectGeoIntent("vegetarian food in Rio de Janeiro")!.near).toEqual({ kind: "place", name: "Rio de Janeiro" });
  });

  it("means 'here' for near-me phrasings and for no location at all", () => {
    for (const q of ["vegan near me", "restaurantes veganos perto de mim", "where can I eat gluten free around here", "best ramen restaurants", "vegan food"]) {
      expect(detectGeoIntent(q)?.near).toEqual({ kind: "device" });
    }
    expect(detectGeoIntent("sem glúten perto de mim")!.diet).toEqual(["gluten_free"]);
    expect(detectGeoIntent("best ramen restaurants")!.text).toBe("ramen");
  });

  it("ignores non-place questions", () => {
    for (const q of [
      "Which signature algorithms are quantum resistant?",
      "What is a vegan diet?".replace("diet", "lifestyle"),
      "Compare the causes of the French Revolution and the Industrial Revolution",
      "What is the capital of Australia?",
      "What food did the Romans eat?",
      "How is coffee made?",
      "Why do vegans avoid honey?",
      "What is the history of pizza in Naples?",
      // Prism V1: diet + place noun is places, a place noun alone is not; a yes/no diet question is not.
      "What are the most historic places in Rome?",
      "Is honey vegan in Europe?",
    ]) {
      expect(detectGeoIntent(q)).toBeNull();
    }
  });
});

describe("detectGeoIntent: Prism V1 cases (city in any case, PT 'de', diet + place noun)", () => {
  it("V1-A: a lower-case city becomes a gazetteer candidate, not a GPS search", () => {
    const i = detectGeoIntent("tell me the best vegan restaurants in berlin")!;
    expect(i.near).toEqual({ kind: "device" });
    expect(i.placeCandidates?.[0]).toBe("berlin");
    expect(detectGeoIntent("melhores restaurantes veganos em são paulo")!.placeCandidates?.[0]).toBe("são paulo");
    expect(detectGeoIntent("restaurantes veganos em sao paulo")!.placeCandidates?.[0]).toBe("sao paulo");
    expect(detectGeoIntent("vegan restaurants in new york city")!.placeCandidates?.slice(0, 2)).toEqual(["new york city", "new york"]);
  });

  it("V1-B: PT 'de <Cidade>'", () => {
    const i = detectGeoIntent("Quais os melhores restaurantes veganos de Roma?")!;
    expect(i).toMatchObject({ near: { kind: "device" }, diet: ["vegan"], lang: "pt" });
    expect(i.placeCandidates).toContain("Roma");
  });

  it("V1-C: diet + place noun + city is a places question, never the LLM", () => {
    expect(detectGeoIntent("best vegan places in Tokyo")).toMatchObject({ near: { kind: "place", name: "Tokyo" }, diet: ["vegan"] });
    expect(detectGeoIntent("best vegan places in tokyo")!.placeCandidates?.[0]).toBe("tokyo");
    expect(detectGeoIntent("lugares veganos em lisboa")!.placeCandidates?.[0]).toBe("lisboa");
    expect(detectGeoIntent("good vegetarian spots")!.near).toEqual({ kind: "device" });
  });

  it("no candidates for the device phrasings or for non-place words after 'in'", () => {
    expect(detectGeoIntent("Tell me the best vegan restaurants in the city I am currently in")!.placeCandidates).toBeUndefined();
    expect(detectGeoIntent("vegan restaurants in my area")!.placeCandidates).toBeUndefined();
    expect(detectGeoIntent("best vegan restaurants in the area")!.placeCandidates).toBeUndefined();
  });
});

describe("formatDistance", () => {
  it("rounds to 10 m and switches to km", () => {
    expect(formatDistance(347)).toBe("350 m");
    expect(formatDistance(1260)).toBe("1.3 km");
    expect(formatDistance(12_400)).toBe("12 km");
  });
});

describe("noMatchAnswer (T2-6)", () => {
  const intent = (q: string) => detectGeoIntent(q)!;
  it("names the filter asked: diet, else the dish, else any place to eat", () => {
    expect(noMatchAnswer(intent("best ramen restaurants in Rome"), "Rome", 10_000)).toBe(
      'The offline map for Rome has no place matching "ramen" within 10 km, so I won\'t list any rather than guess.'
    );
    expect(noMatchAnswer(intent("restaurants in Rome"), "Rome", 25_000)).toBe(
      "The offline map for Rome has no place to eat or drink recorded within 25 km, so I won't list any rather than guess."
    );
    expect(noMatchAnswer(intent("vegan or halal restaurants in Rome"), "Rome", 25_000)).toMatch(/no place tagged vegan or halal within 25 km/);
  });

  it("with a diet and a dish, names both: 'no place tagged kosher' alone is false when kosher places exist (Sextant)", () => {
    const i = intent("kosher ramen in Rome");
    expect(i).toMatchObject({ diet: ["kosher"], text: "ramen" });
    expect(noMatchAnswer(i, "Rome", 25_000)).toBe(
      'The offline map for Rome has no place tagged kosher that matches "ramen" within 25 km, so I won\'t list any rather than guess.'
    );
    expect(noMatchAnswer({ ...i, lang: "pt" }, "Roma", 25_000)).toBe(
      'O mapa offline de Roma não tem nenhum lugar marcado como kosher com "ramen" num raio de 25 km, então não vou listar nenhum para não inventar.'
    );
  });
});

// ---- Pipeline --------------------------------------------------------------

const poi = (id: string, name: string, distanceM: number, vegan: "only" | "yes" | "limited", extra: Partial<PoiRecord> = {}): PoiRecord & { distanceM: number } => ({
  id,
  name,
  lat: -23.56,
  lon: -46.65,
  category: "restaurant",
  cuisine: ["vegan"],
  diet: { vegan },
  address: `Rua ${name} 1, São Paulo`,
  osmDate: "2026-08",
  source: { kind: "osm", url: `https://www.openstreetmap.org/${id.replace("osm:", "")}` },
  distanceM,
  ...extra,
});
const SP_POIS = [
  poi("osm:node/1", "Tokyo Vegan", 420, "only"),
  poi("osm:node/2", "Casa Verde", 1260, "only"),
  poi("osm:node/3", "Padaria Central", 300, "yes"),
  poi("wikivoyage:São_Paulo#4", "Feira Orgânica", 0, "yes", {
    approx: true,
    source: { kind: "wikivoyage", url: "https://en.wikivoyage.org/wiki/São_Paulo", title: "São Paulo/Eat" },
    description: "Weekend organic market.",
  }),
];

let geo: GeoProviders & { calls: string[] };
let loads = 0;
const makeGeo = () => {
  const calls: string[] = [];
  return {
    calls,
    async getLocation() {
      calls.push("location");
      return { lat: -23.56, lon: -46.65, accuracyM: 20, ageS: 5 };
    },
    async resolvePlace(name: string) {
      calls.push(`resolve:${name}`);
      return /s[aã]o paulo/i.test(name) ? { name: "São Paulo", lat: -23.55, lon: -46.63, country: "BR", kind: "city" } : null;
    },
    async searchPois() {
      calls.push("search");
      return { pois: SP_POIS, radiusUsedM: 3000, coverage: "full" as const };
    },
  };
};

const deps = (): AnswerDeps => ({
  now: (() => {
    let t = 0;
    return () => (t += 3);
  })(),
  engine: {
    load: async () => {
      loads++;
      return { fit: null, warning: null };
    },
    generate: async () => {
      throw new Error("the places path must not call a model");
    },
    stop: async () => {},
    getModelInfo: () => null,
    hasEmbeddedChatTemplate: () => true,
    estimateFit: async () => null,
  },
  retrieve: async () => [],
  getSettings: async () => ({ quickFirst: true, alwaysComplete: false, deepModelId: undefined }),
  listInstalledLlms: async () => [],
  getActiveModelId: async () => null,
  runMultipass: async () => {
    throw new Error("no");
  },
  assemblePrompt: () => "",
  assembleChatMessages: () => [],
  getGeoProviders: () => geo,
});

beforeEach(() => {
  geo = makeGeo();
  loads = 0;
});

async function ask(query: string, extra: { place?: string } = {}, d = deps()) {
  const events: AnswerEvent[] = [];
  const r = await createAnswerer(d).answer({ query, ...extra }, (e) => events.push(e), { maxTokens: 256 }).done;
  return { r, events, places: events.find((e) => e.type === "places") as Extract<AnswerEvent, { type: "places" }> | undefined };
}

describe("answer(): places path", () => {
  it("answers 'near me' from the records only, before any model, with distance, source and attribution", async () => {
    const { r, events, places } = await ask("Tell me the best vegan restaurants in the city I am currently in");
    expect(events.map((e) => e.type)).toEqual(["stage", "location", "sources", "places", "done"]);
    expect(loads).toBe(0);
    expect(r).toMatchObject({ tier: "instant", outcome: "success" });
    expect(r.receipt.modelId).toBe("places");
    expect(places!.coverage).toBe("ok");
    expect(places!.criterion).toBe("diet_match");
    expect(places!.places.slice(0, 3).map((p) => p.name)).toEqual(["Tokyo Vegan", "Casa Verde", "Padaria Central"]);
    expect(places!.places[0]).toMatchObject({ distanceM: 420, sourceIndex: 0, source: "osm" });
    // Approximate Wikivoyage entries never get a distance.
    expect(places!.places[3].distanceM).toBeUndefined();
    expect(places!.attribution).toEqual([
      { source: "osm", date: "2026-08", license: "ODbL" },
      { source: "wikivoyage", license: "CC BY-SA" },
    ]);
    // Zero invented places: every name in the text is a record.
    const listedNames = r.text.split("\n").filter((l) => /^\d+\. |^- /.test(l)).map((l) => l.replace(/^\d+\. |^- /, "").split(/ — |: /)[0]);
    expect(listedNames.every((n) => SP_POIS.some((p) => p.name === n))).toBe(true);
    expect(r.text).toMatch(/1\. Tokyo Vegan — 420 m — Rua Tokyo Vegan 1, São Paulo — vegan: only \[1\]/);
    expect(r.text).toMatch(/ratings and popularity are not available offline/);
    expect(r.receipt.ttftMs).toBeLessThan(1000);
  });

  it("V1-A/B: a lower-case or 'de' city counts once the gazetteer knows it", async () => {
    const { places } = await ask("melhores restaurantes veganos em são paulo");
    expect(geo.calls).toEqual(["resolve:são paulo", "resolve:são paulo", "location", "search"]);
    expect(places!.area).toMatchObject({ kind: "city", label: "São Paulo" });
    expect(places!.places.every((p) => p.distanceM === undefined)).toBe(true);
    geo = makeGeo();
    const de = await ask("restaurantes veganos de sao paulo");
    expect(de.places!.area.kind).toBe("city");
  });

  it("ignores a weak gazetteer hit: a small town under another name", async () => {
    geo.resolvePlace = async (name: string) => {
      geo.calls.push(`resolve:${name}`);
      return { name: "Ózd", lat: 48.2, lon: 20.3, country: "HU", kind: "town" };
    };
    const { places } = await ask("vegan restaurants in midtown");
    expect(places!.area.kind).toBe("near");
    expect(detectGeoIntent("vegan restaurants in downtown")!.placeCandidates).toBeUndefined();
    expect(detectGeoIntent("vegan restaurants in asia")!.placeCandidates).toBeUndefined();
  });

  it("G-3: deviceInside when a recent fix is within the named city, so the UI can use the device clock", async () => {
    const inSp = await ask("vegan restaurants in São Paulo");
    expect(inSp.places!.area).toMatchObject({ kind: "city", deviceInside: true });
    expect(inSp.events.some((e) => e.type === "location")).toBe(false);

    geo = makeGeo();
    geo.getLocation = async () => ({ lat: 52.52, lon: 13.4, accuracyM: 20, ageS: 5 }); // Berlin
    expect((await ask("vegan restaurants in São Paulo")).places!.area.deviceInside).toBeUndefined();

    geo = makeGeo();
    geo.getLocation = async () => ({ error: "prompt" as const });
    expect((await ask("vegan restaurants in São Paulo")).places!.area.deviceInside).toBeUndefined();
  });

  it("G-3: a fix that is not in when the POI search ends is ignored; the list never waits", async () => {
    geo.getLocation = () => new Promise(() => {});
    const t = Date.now();
    const { places } = await ask("vegan restaurants in São Paulo");
    expect(places!.area.deviceInside).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(50);

    geo = makeGeo();
    geo.getLocation = () => new Promise((r) => setTimeout(() => r({ lat: -23.56, lon: -46.65 }), DEVICE_INSIDE_TIMEOUT_MS));
    expect((await ask("vegan restaurants in São Paulo")).places!.area.deviceInside).toBeUndefined();
  });

  it("a candidate the gazetteer doesn't know falls back to the device, never to the model", async () => {
    const { r, places } = await ask("best vegan restaurants in xyzzy");
    expect(geo.calls).toEqual(["resolve:xyzzy", "location", "search"]);
    expect(places!.area.kind).toBe("near");
    expect(r.receipt.modelId).toBe("places");
    expect(loads).toBe(0);
  });

  it("uses a named city without distances (a cached fix only sets deviceInside)", async () => {
    const { r, places } = await ask("melhores restaurantes veganos em São Paulo");
    expect(geo.calls).toEqual(["resolve:São Paulo", "location", "search"]);
    expect(places!.area).toMatchObject({ kind: "city", label: "São Paulo", place: { name: "São Paulo", asked: "São Paulo", country: "BR" } });
    expect(places!.places.every((p) => p.distanceM === undefined)).toBe(true);
    expect(r.text).toMatch(/^Lugares com opção vegano em São Paulo/);
  });

  it("in a named city, lists places with an address before those without", async () => {
    geo.searchPois = async () => ({
      pois: [poi("osm:node/7", "No Address Vegan", 0, "only", { address: undefined }), ...SP_POIS],
      radiusUsedM: 3000,
      coverage: "full" as const,
    });
    const { places, r } = await ask("vegan restaurants in São Paulo");
    expect(places!.places.map((p) => p.name)).toEqual(["Tokyo Vegan", "Casa Verde", "Padaria Central", "No Address Vegan", "Feira Orgânica"]);
    // sourceIndex follows the emitted order.
    expect(places!.places.map((p) => p.sourceIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(r.text).toMatch(/OpenStreetMap \(extract 2026-08\), maintained by volunteers/);
  });

  it("never gives a doubtful diet tag the strong label, and keeps 'verify' places last", async () => {
    geo.searchPois = async () => ({
      pois: [
        poi("osm:node/1", "Tokyo Vegan", 420, "only"),
        poi("osm:node/9", "Maybe Vegan", 500, "yes", { dietFlag: "uncertain", dietCheck: 0.5, dietCheckFor: "vegan", address: undefined }),
        poi("osm:node/8", "MOS Burger", 600, "only", { dietFlag: "verify", dietCheck: 0.1, dietCheckFor: "vegan" }),
      ],
      radiusUsedM: 3000,
      coverage: "full" as const,
    });
    const { places, r } = await ask("best vegan restaurants in São Paulo");
    expect(places!.places.map((p) => p.name)).toEqual(["Tokyo Vegan", "Maybe Vegan", "MOS Burger"]);
    expect(places!.places.map((p) => p.dietFlag)).toEqual([undefined, "uncertain", "verify"]);
    expect(r.text).toMatch(/MOS Burger — Rua MOS Burger 1, São Paulo — OSM vegan tag to verify/);
    expect(r.text).toMatch(/Maybe Vegan — vegan tag \(unconfirmed\)/);
    expect(r.text).not.toMatch(/MOS Burger.*vegan: only/);
  });

  it("says it has no offline data for an unknown city instead of listing anything", async () => {
    const { r, places } = await ask("best vegan restaurants in Ulaanbaatar");
    expect(places!.coverage).toBe("none");
    expect(places!.places).toEqual([]);
    expect(r.text).toBe("I don't have offline place data for Ulaanbaatar, so I won't list any restaurants rather than guess.");
  });

  it("says so when no map covers the area near the device, naming no pack or tile id (T2-7)", async () => {
    geo.searchPois = async () => ({ pois: [], radiusUsedM: 25_000, coverage: "none", region: "t-N41E012" });
    const { r, places } = await ask("vegan near me");
    expect(places!).toMatchObject({ coverage: "none", empty: "no_data" });
    expect(r.text).toBe("I don't have offline place data near you, so I won't list any restaurants rather than guess.");
    expect(r.text).not.toMatch(/t-N41E012/);
  });

  it("marks an unknown city as no_data", async () => {
    const { places } = await ask("best vegan restaurants in Ulaanbaatar");
    expect(places!.empty).toBe("no_data");
  });

  it("T2-6: a map covering the city with nothing tagged says so, never 'no data'", async () => {
    geo.searchPois = async () => ({ pois: [], radiusUsedM: 25_000, coverage: "full", region: "t-N41E012" });
    const { r, places } = await ask("best vegan restaurants in São Paulo");
    expect(places!).toMatchObject({ coverage: "none", empty: "no_match", places: [] });
    expect(places!.area).toMatchObject({ kind: "city", label: "São Paulo", radiusM: 25_000 });
    expect(r.text).toBe("The offline map for São Paulo has no place tagged vegan within 25 km, so I won't list any rather than guess.");
    expect(r.text).not.toMatch(/don't have offline place data|t-N41E012/);
    expect(r.receipt.reasonCodes).toContain("places:no-match");
    expect(loads).toBe(0);
  });

  it("T2-6: the same in Portuguese, and near the device (partial coverage counts as covered)", async () => {
    geo.searchPois = async () => ({ pois: [], radiusUsedM: 25_000, coverage: "full" });
    const pt = await ask("melhores restaurantes veganos em São Paulo");
    expect(pt.places!.empty).toBe("no_match");
    expect(pt.r.text).toBe("O mapa offline de São Paulo não tem nenhum lugar marcado como vegano num raio de 25 km, então não vou listar nenhum para não inventar.");

    geo = makeGeo();
    geo.searchPois = async () => ({ pois: [], radiusUsedM: 25_000, coverage: "partial", region: "t-N41E012" });
    const near = await ask("vegan near me");
    expect(near.places!).toMatchObject({ coverage: "none", empty: "no_match" });
    expect(near.r.text).toBe("The offline map near you has no place tagged vegan within 25 km, so I won't list any rather than guess.");
  });

  it("T2-8: a resolved city carries its point, so an empty answer can offer the map covering it", async () => {
    geo.searchPois = async () => ({ pois: [], radiusUsedM: 3000, coverage: "none" });
    const { places } = await ask("best vegan restaurants in São Paulo");
    expect(places!).toMatchObject({ coverage: "none", empty: "no_data" });
    expect(places!.area.place).toMatchObject({ name: "São Paulo", lat: expect.any(Number), lon: expect.any(Number) });
  });

  it("asks for the city when location is denied, then answers with answer({ place })", async () => {
    geo.getLocation = async () => ({ error: "denied" as const });
    const first = await ask("vegan restaurants near me");
    expect(first.events.find((e) => e.type === "location")).toMatchObject({ status: "denied" });
    expect(first.places!.coverage).toBe("needs_place");
    expect(first.r.text).toMatch(/Which city are you in\?/);
    const second = await ask("vegan restaurants near me", { place: "São Paulo" });
    expect(second.places!.coverage).toBe("ok");
    expect(second.places!.area.kind).toBe("city");
  });

  it("reports a missing places pack", async () => {
    const d = deps();
    d.getGeoProviders = () => null;
    const { places, r } = await ask("vegan near me", {}, d);
    expect(places!.coverage).toBe("no_pack");
    expect(r.text).toMatch(/not installed/);
  });

  it("reports a missing pack when providers are registered but no pack is installed", async () => {
    geo.hasPlaces = async () => false;
    const { places } = await ask("best vegan restaurants in São Paulo");
    expect(places!.coverage).toBe("no_pack");
    expect(geo.calls).toEqual([]);
  });

  it("leaves ordinary questions to the normal pipeline", async () => {
    const { places } = await ask("Which signature algorithms are quantum resistant?");
    expect(places).toBeUndefined();
    expect(geo.calls).toEqual([]);
  });
});

describe("answer(): 'near me' location wait (GPS-1) and age rule", () => {
  const NEAR = "Tell me the best vegan restaurants in the city I am currently in";
  const locEvents = (events: AnswerEvent[]) => events.filter((e) => e.type === "location").map((e: any) => e.status);

  it("a fix of 5 min or less is used at once, with no 'locating'", async () => {
    geo.getLocationFix = async () => ({ lat: -23.56, lon: -46.65, accuracyM: 20, ageS: 120 });
    const { events, places } = await ask(NEAR);
    expect(locEvents(events)).toEqual(["granted"]);
    expect(places!.area.kind).toBe("near");
    expect(places!.places.length).toBeGreaterThan(0);
  });

  it("cold GPS: says 'locating', then lists as soon as the fix arrives", async () => {
    geo.getLocationFix = () => new Promise((r) => setTimeout(() => r({ lat: -23.56, lon: -46.65, accuracyM: 30, ageS: 0 }), LOCATING_SIGNAL_MS + 150));
    const { events, places, r } = await ask(NEAR);
    expect(locEvents(events)).toEqual(["locating", "granted"]);
    expect(places!.coverage).toBe("ok");
    expect(r.receipt.reasonCodes).toContain("location:locating");
  });

  it("Piston's case: only a 23-min-old fix (Berlin) -> never lists Berlin, offers it by name", async () => {
    geo.getLocationFix = async () => ({ error: "stale" as const, last: { lat: 52.52, lon: 13.4, accuracyM: 15, ageS: 1380 } });
    geo.nearestCity = async () => ({ name: "Berlin", country: "Germany" });
    const { events, places } = await ask(NEAR);
    expect(geo.calls).not.toContain("search");
    expect(events.find((e) => e.type === "location")).toMatchObject({ status: "stale", ageS: 1380 });
    expect(places!.coverage).toBe("needs_place");
    expect(places!.area).toEqual({ kind: "near", lastKnown: { city: "Berlin", country: "Germany", ageS: 1380 } });
    expect((await ask(NEAR)).r.text).toBe("I couldn't get a current location. The last one was in Berlin, 23 min ago. Are you still there, or which city are you in?");
  });

  it("an old fix with no known city just asks for the city", async () => {
    geo.getLocationFix = async () => ({ error: "stale" as const, last: { lat: 0, lon: 0, ageS: 3600 } });
    geo.nearestCity = async () => null;
    const { places } = await ask(NEAR);
    expect(places!.area).toEqual({ kind: "near" });
    expect(places!.coverage).toBe("needs_place");
  });

  it("no fix at all within the wait -> asks for the city", async () => {
    geo.getLocationFix = async () => ({ error: "timeout" as const });
    const { events, places } = await ask(NEAR);
    expect(locEvents(events)).toEqual(["unavailable"]);
    expect(places!.coverage).toBe("needs_place");
  });

  it("stop() while waiting for the GPS ends the answer at once (the user typed a city)", async () => {
    geo.getLocationFix = () => new Promise(() => {});
    const events: AnswerEvent[] = [];
    const h = createAnswerer(deps()).answer({ query: NEAR }, (e) => events.push(e), { maxTokens: 256 });
    await new Promise((r) => setTimeout(r, LOCATING_SIGNAL_MS + 50));
    expect(locEvents(events)).toEqual(["locating"]);
    const t = Date.now();
    await h.stop();
    const r = await h.done;
    expect(Date.now() - t).toBeLessThan(100);
    expect(r.outcome).toBe("stopped");
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "stopped" });
  });
});

describe("detectGeoIntent: customs are knowledge, not places (Sextant trv-009)", () => {
  it("tipping/etiquette/payment questions about restaurants are not places questions", () => {
    for (const q of [
      "Is tipping expected in restaurants in Portugal?",
      "É esperado dar gorjeta em restaurantes em Portugal?",
      "Do restaurants in Japan accept credit cards?",
      "Preciso reservar restaurantes em Paris?",
    ]) expect(detectGeoIntent(q), q).toBeNull();
  });
  it("a request for places stays one", () => {
    for (const q of ["Best vegan restaurants in Lisbon", "Onde comer em Lisboa?", "Recommend restaurants in Tokyo that accept credit cards"]) expect(detectGeoIntent(q), q).not.toBeNull();
  });
});

describe("dedupPlaces: one record per real place (The Conscious Kitchen twice in Cape Town)", () => {
  // Woodstock, Cape Town: the OSM node and its building way, ~20 m apart.
  const ck = (id: string, name: string, lat: number, lon: number, extra: Partial<PoiRecord> = {}) =>
    poi(id, name, 800, "yes", { lat, lon, address: undefined, ...extra });

  it("normalizes case, articles, accents and punctuation", () => {
    expect(normalizePlaceName("The Conscious Kitchen")).toBe("conscious kitchen");
    expect(normalizePlaceName("the conscious-kitchen")).toBe("conscious kitchen");
    expect(normalizePlaceName("Conscious Kitchen, The")).toBe("conscious kitchen");
    expect(normalizePlaceName("Café  Crème")).toBe("cafe creme");
    expect(normalizePlaceName("A Casa do Porco")).toBe("casa do porco");
    expect(normalizePlaceName("The")).toBe("the");
  });

  it("keeps the first of two same-name records under 50 m, filling what it lacks", () => {
    const a = ck("osm:node/10", "The Conscious Kitchen", -33.92695, 18.44641);
    const b = ck("osm:way/11", "The Conscious Kitchen", -33.9271, 18.4465, { address: "Woodstock Exchange, 66 Albert Rd", openingHours: "Mo-Fr 08:00-15:00" });
    const other = ck("osm:node/12", "Plant Café", -33.9272, 18.4466);
    const out = dedupPlaces([a, other, b]);
    expect(out.map((p) => p.id)).toEqual(["osm:node/10", "osm:node/12"]);
    expect(out[0]).toMatchObject({ address: "Woodstock Exchange, 66 Albert Rd", openingHours: "Mo-Fr 08:00-15:00" });
  });

  it("keeps same-name places 50 m or more apart (two branches) and different names at the same spot", () => {
    const a = ck("osm:node/20", "Kauai", -33.92, 18.42);
    const b = ck("osm:node/21", "Kauai", -33.9205, 18.42); // ~56 m
    const c = ck("osm:node/22", "Kauai Express", -33.92, 18.42);
    expect(dedupPlaces([a, b, c]).map((p) => p.id)).toEqual(["osm:node/20", "osm:node/21", "osm:node/22"]);
  });

  it("answer(): the places list names The Conscious Kitchen once", async () => {
    const pois = [
      ck("osm:node/10", "The Conscious Kitchen", -33.92695, 18.44641, { address: "66 Albert Rd" }),
      ck("osm:way/11", "The Conscious Kitchen", -33.9271, 18.4465, { address: "66 Albert Rd, Woodstock" }),
      ck("osm:node/12", "Plant Café", -33.9272, 18.4466, { address: "8 Buitenkant St" }),
    ];
    geo.searchPois = async () => ({ pois, radiusUsedM: 3000, coverage: "full" as const });
    const { r, places } = await ask("vegan near me");
    expect(places!.places.map((p) => p.name)).toEqual(["The Conscious Kitchen", "Plant Café"]);
    expect(r.text.match(/The Conscious Kitchen/g)).toHaveLength(1);
    expect(r.receipt.reasonCodes).toContain("places:dedup-1");
  });
});
