import { describe, it, expect, afterEach } from "vitest";
import { allAssets, findAsset, notifyAssetInstalled, onAssetInstalled, registerAssetProvider, requirementsOf, unregisterAssetProvider } from "./assetRegistry";
import { MODEL_CATALOG, type CatalogModel } from "./manifest";

const entry = (id: string, filename = `poi/${id}.sqlite`): CatalogModel => ({
  id,
  kind: "corpus",
  format: "poi-pack",
  label: id,
  filename,
  sizeBytes: 100,
  sha256: "a".repeat(64),
  sourceUrl: "",
  license: "ODbL",
  description: "",
  required: false,
});

afterEach(() => {
  unregisterAssetProvider("test");
  unregisterAssetProvider("other");
});

describe("assetRegistry", () => {
  it("is the curated catalog when nothing else registered", () => {
    expect(allAssets().map((a) => a.id)).toEqual(MODEL_CATALOG.map((a) => a.id));
  });

  it("adds registered providers after the catalog, read lazily", () => {
    let regions = [entry("poi-lisbon")];
    registerAssetProvider("test", () => regions);
    expect(allAssets().at(-1)?.id).toBe("poi-lisbon");
    regions = [entry("poi-lisbon"), entry("poi-world-places", "poi/world-places.sqlite")];
    expect(findAsset("poi-world-places")?.filename).toBe("poi/world-places.sqlite");
  });

  it("keeps the first entry on a duplicate id and refuses two ids on one filename", () => {
    registerAssetProvider("test", () => [entry("poi-a")]);
    registerAssetProvider("other", () => [{ ...entry("poi-a"), label: "dup" }]);
    expect(allAssets().filter((a) => a.id === "poi-a")).toHaveLength(1);
    expect(findAsset("poi-a")?.label).toBe("poi-a");
    registerAssetProvider("other", () => [entry("poi-b", "poi/poi-a.sqlite")]);
    expect(() => allAssets()).toThrow(/both install to poi\/poi-a\.sqlite/);
  });
});

describe("requirementsOf", () => {
  afterEach(() => unregisterAssetProvider("req-test"));

  it("resolves required ids in the registry and reports the ones it doesn't know", () => {
    registerAssetProvider("req-test", () => [entry("world-places-test"), { ...entry("berlin-test"), requires: ["world-places-test", "nope"] }]);
    const r = requirementsOf(findAsset("berlin-test")!);
    expect(r.assets.map((a) => a.id)).toEqual(["world-places-test"]);
    expect(r.unknown).toEqual(["nope"]);
    expect(requirementsOf(findAsset("world-places-test")!)).toEqual({ assets: [], unknown: [] });
    expect(requirementsOf({ id: "world-places-test", requires: ["world-places-test"] })).toEqual({ assets: [], unknown: [] });
  });

  it("every registered asset's requirements exist in the registry", () => {
    for (const a of allAssets()) expect(requirementsOf(a).unknown, a.id).toEqual([]);
  });
});


describe("onAssetInstalled", () => {
  it("tells every listener, even when one throws, and stops after unsubscribe", () => {
    const seen: string[] = [];
    const offBad = onAssetInstalled(() => {
      throw new Error("boom");
    });
    const off = onAssetInstalled((a) => seen.push(a.id));
    notifyAssetInstalled({ id: "poi-world-places" } as CatalogModel);
    off();
    offBad();
    notifyAssetInstalled({ id: "poi-world-places" } as CatalogModel);
    expect(seen).toEqual(["poi-world-places"]);
  });
});

describe("notifyAssetInstalled", () => {
  it("waits for async listeners (the tile index is registered before the next import is checked)", async () => {
    let registered = false;
    const off = onAssetInstalled(async () => {
      await new Promise((r) => setTimeout(r, 5));
      registered = true;
    });
    await notifyAssetInstalled({ id: "poi-world-places" } as CatalogModel);
    off();
    expect(registered).toBe(true);
  });
});
