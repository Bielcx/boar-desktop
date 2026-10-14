import { describe, it, expect, vi } from "vitest";
import { geoProvidersFrom, GeoSources } from "./geoWiring";

function sources(over: Partial<GeoSources> = {}): GeoSources {
  return {
    installedPoiPacks: async () => [],
    getCurrentPoint: async () => ({ lat: 1, lon: 2, accuracyM: 5, ageS: 0 }),
    resolvePlace: async () => null,
    searchPois: async () => ({ pois: [], radiusUsedM: 3000, coverage: "none", criterion: "distance", timingsMs: { search: 0 } }),
    ...over,
  };
}

describe("geoProvidersFrom", () => {
  it("has places only when a pack is installed", async () => {
    expect(await geoProvidersFrom(sources()).hasPlaces!()).toBe(false);
    expect(await geoProvidersFrom(sources({ installedPoiPacks: async () => [{}] })).hasPlaces!()).toBe(true);
    expect(await geoProvidersFrom(sources({ installedPoiPacks: () => Promise.reject(new Error("io")) })).hasPlaces!()).toBe(false);
  });

  it("forwards location, place and POI calls unchanged", async () => {
    const getCurrentPoint = vi.fn(async () => ({ error: "denied" as const }));
    const resolvePlace = vi.fn(async () => ({ name: "Lisbon", lat: 38.7, lon: -9.1, kind: "city" }));
    const searchPois = vi.fn(sources().searchPois);
    const p = geoProvidersFrom(sources({ getCurrentPoint, resolvePlace, searchPois }));

    expect(await p.getLocation({ timeoutMs: 1234 })).toEqual({ error: "denied" });
    expect(getCurrentPoint).toHaveBeenCalledWith({ timeoutMs: 1234 });
    expect((await p.resolvePlace("Lisbon"))?.name).toBe("Lisbon");
    const q = { center: { lat: 38.7, lon: -9.1 }, diet: ["vegan" as const], limit: 5 };
    await p.searchPois(q);
    expect(searchPois).toHaveBeenCalledWith(q);
  });

  it("names the nearest known city within 50 km of an old fix, or none", async () => {
    const p = geoProvidersFrom(sources({ cities: () => [{ name: "Berlin", lat: 52.52, lon: 13.4 }, { name: "Qujing", lat: 25.49, lon: 103.8 }] }));
    expect(await p.nearestCity!({ lat: 52.45, lon: 13.3 })).toEqual({ name: "Berlin" });
    expect(await p.nearestCity!({ lat: 40, lon: 0 })).toBeNull();
    expect(await geoProvidersFrom(sources()).nearestCity!({ lat: 52.5, lon: 13.4 })).toBeNull();
  });

  it("passes getLocationFix through when the app has it", async () => {
    const getLocationFix = async () => ({ error: "stale" as const, last: { lat: 1, lon: 2, ageS: 900 } });
    expect(geoProvidersFrom(sources({ getLocationFix })).getLocationFix).toBe(getLocationFix);
    expect(geoProvidersFrom(sources()).getLocationFix).toBeUndefined();
  });

  it("PL-1: without the place-names index, a city of the installed packs still resolves by name", async () => {
    const cities = () => [{ name: "Berlin", lat: 52.52, lon: 13.4 }, { name: "São Paulo", lat: -23.55, lon: -46.63 }];
    const p = geoProvidersFrom(sources({ resolvePlace: async () => null, cities }));
    expect(await p.resolvePlace("Berlin")).toEqual({ name: "Berlin", lat: 52.52, lon: 13.4, kind: "city" });
    expect(await p.resolvePlace("sao paulo")).toMatchObject({ name: "São Paulo" });
    expect(await p.resolvePlace("Atlantis")).toBeNull();
    // Portuguese names through the PT->EN lexicon (Boar, residual of PL-1).
    expect(await p.resolvePlace("Berlim")).toMatchObject({ name: "Berlin" });
    // Cleaned like the gazetteer (cleanPlaceName): punctuation, a leading preposition, ", Country".
    for (const n of ["Berlin?", "in Berlin", "Berlin, Germany", "em Berlim"]) expect(await p.resolvePlace(n), n).toMatchObject({ name: "Berlin" });
    // A failing gazetteer (missing file) falls back too.
    const broken = geoProvidersFrom(sources({ resolvePlace: () => Promise.reject(new Error("no such table")), cities }));
    expect(await broken.resolvePlace("Berlin")).toMatchObject({ name: "Berlin" });
  });
});
