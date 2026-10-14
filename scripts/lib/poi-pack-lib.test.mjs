import { describe, it, expect } from "vitest";
import { addressOf, categoryOf, cellOf, CELLS_PER_ROW, cuisinesOf, dietOf, voyageListings } from "./poi-pack-lib.mjs";

describe("cellOf", () => {
  it("is row-major on a 0.01° grid", () => {
    expect(cellOf(0, 0)).toBe(9000 * CELLS_PER_ROW + 18000);
    expect(cellOf(0.005, 0.009)).toBe(cellOf(0, 0));
    expect(cellOf(0, 0.01)).toBe(cellOf(0, 0) + 1);
    expect(cellOf(0.01, 0)).toBe(cellOf(0, 0) + CELLS_PER_ROW);
    expect(cellOf(-23.55, -46.63)).toBeGreaterThan(0);
  });
});

describe("tags", () => {
  it("reads diet tags and treats cuisine=vegan as vegan only", () => {
    expect(dietOf({ "diet:vegan": "yes", "diet:vegetarian": "only", "diet:halal": "maybe" })).toEqual({ vegan: "yes", vegetarian: "only" });
    expect(dietOf({ cuisine: "vegan;burger" })).toEqual({ vegan: "only" });
    expect(dietOf({ cuisine: "vegan", "diet:vegan": "limited" })).toEqual({ vegan: "limited" });
    expect(dietOf({ cuisine: "pizza" })).toEqual({});
  });
  it("formats addresses and categories", () => {
    expect(addressOf({ "addr:street": "Rua Augusta", "addr:housenumber": "1500", "addr:suburb": "Consolação", "addr:city": "São Paulo" })).toBe(
      "Rua Augusta, 1500, Consolação, São Paulo"
    );
    expect(addressOf({ "addr:housenumber": "3" })).toBeNull();
    expect(cuisinesOf({ cuisine: "Thai; Vegan" })).toEqual(["thai", "vegan"]);
    expect(categoryOf({ amenity: "restaurant;cafe" })).toBe("restaurant");
    expect(categoryOf({ shop: "bakery" })).toBe("bakery");
  });
});

describe("voyageListings", () => {
  const page = [
    "Intro text {{see|name=Museum|lat=1|long=2}}",
    "==Eat==",
    "===Budget===",
    "* {{eat| name=Green Leaf | address=Rua X, 10 | lat=-23.55 | long=-46.63 | hours=11:00-15:00",
    "| price=R$30 | content=All-[[vegan]] buffet. }}",
    "* {{listing|name=No Coords Café|content=Cheap coffee.}}",
    "==Drink==",
    "* {{drink|name=Bar Um|lat=bad|long=|content=Beer.}}",
    "==Sleep==",
    "* {{sleep|name=Hotel|lat=1|long=2}}",
  ].join("\n");

  it("reads Eat and Drink listings only, across lines, with coordinates when valid", () => {
    const l = voyageListings(page);
    expect(l.map((x) => [x.section, x.name, x.lat, x.lon])).toEqual([
      ["Eat", "Green Leaf", -23.55, -46.63],
      ["Eat", "No Coords Café", null, null],
      ["Drink", "Bar Um", null, null],
    ]);
    expect(l[0]).toMatchObject({ address: "Rua X, 10", hours: "11:00-15:00", price: "R$30", content: "All-vegan buffet." });
  });
});
