import { describe, expect, it } from "vitest";
import { BUNDLED_FAMILIES, CODE, DISPLAY, familyFor, fontScaleFactor, scaledLineHeight, scaledSize } from "./fonts";

describe("familyFor", () => {
  it("reads text in Lexend at the nearest weight", () => {
    expect(familyFor(undefined, undefined).family).toBe("Lexend_400Regular");
    expect(familyFor("sans-serif", "500").family).toBe("Lexend_500Medium");
    expect(familyFor("System", "600").family).toBe("Lexend_600SemiBold");
    expect(familyFor(undefined, "bold").family).toBe("Lexend_700Bold");
    expect(familyFor(undefined, 700).family).toBe("Lexend_700Bold");
  });

  it("sets heavy weights and display styles in Baloo 2", () => {
    expect(familyFor(undefined, "800").family).toBe("Baloo2_800ExtraBold");
    expect(familyFor("sans-serif", "900").family).toBe("Baloo2_800ExtraBold");
    expect(familyFor(DISPLAY, "700").family).toBe("Baloo2_700Bold");
    expect(familyFor(DISPLAY, undefined).family).toBe("Baloo2_700Bold");
  });

  it("turns monospace into Lexend with fixed-width digits", () => {
    expect(familyFor("monospace", "600")).toEqual({ family: "Lexend_600SemiBold", tabular: true });
    expect(familyFor("Menlo", undefined)).toEqual({ family: "Lexend_400Regular", tabular: true });
  });

  it("leaves code and other fonts alone", () => {
    expect(familyFor(CODE, "700")).toEqual({ family: CODE, tabular: false });
    expect(familyFor("Feather", undefined)).toEqual({ family: "Feather", tabular: false });
  });

  it("only names families that are bundled", () => {
    const weights = [undefined, "100", "400", "500", "600", "700", "bold", "800", "900"];
    for (const face of [undefined, DISPLAY, "monospace", "sans-serif"]) {
      for (const w of weights) expect(BUNDLED_FAMILIES).toContain(familyFor(face, w).family);
    }
  });
});

describe("scaledSize", () => {
  it("puts nothing under 12 and body at 16", () => {
    expect([8, 10, 11, 12, 13, 14, 15].map(scaledSize)).toEqual([12, 12, 12, 13, 14, 16, 16]);
  });

  it("keeps titles", () => {
    expect([16, 20, 32].map(scaledSize)).toEqual([16, 20, 32]);
  });

  it("grows the line height with the text", () => {
    expect(scaledLineHeight(21, 14, 16)).toBe(24);
    expect(scaledLineHeight(22, 16, 16)).toBe(22);
  });
});

describe("fontScaleFactor", () => {
  it("maps the Settings text size, standard when unknown", () => {
    expect(["compact", "standard", "large", undefined].map(fontScaleFactor)).toEqual([0.9, 1, 1.2, 1]);
  });
});
