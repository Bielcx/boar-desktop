import { describe, it, expect } from "vitest";
import { formatBytes, formatBytesParts } from "./units";

describe("formatBytes", () => {
  it("uses decimal units, as Android's file picker does (Prism N-14)", () => {
    // The crypto pack: 35.96 MB in the system picker, not 34.3.
    expect(formatBytes(35_962_880)).toBe("36 MB");
    expect(formatBytes(18_600_000)).toBe("18.6 MB");
    expect(formatBytes(24 * GB)).toBe("24 GB");
  });

  it("shows one decimal below 100 and none from 100 up", () => {
    expect(formatBytes(986_048_768)).toBe("986 MB");
    expect(formatBytes(2_497_281_120)).toBe("2.5 GB");
    expect(formatBytes(99_940_000)).toBe("99.9 MB");
    expect(formatBytes(99_960_000)).toBe("100 MB");
    expect(formatBytes(128 * GB)).toBe("128 GB");
  });

  it("switches unit where the smaller one would round to 1000", () => {
    expect(formatBytes(999_400)).toBe("999 kB");
    expect(formatBytes(999_600)).toBe("1 MB");
    expect(formatBytes(999_400_000)).toBe("999 MB");
    expect(formatBytes(999_999_999)).toBe("1 GB");
  });

  it("never shows a non-empty file as 0 kB", () => {
    expect(formatBytes(10)).toBe("1 kB");
    expect(formatBytes(1_500)).toBe("2 kB");
    expect(formatBytes(0)).toBe("0 kB");
    expect(formatBytes(-5)).toBe("0 kB");
  });

  it("follows the locale's decimal and thousands separators", () => {
    expect(formatBytes(18_600_000, "pt-BR")).toBe("18,6 MB");
    expect(formatBytes(1_300_000_000, "pt-BR")).toBe("1,3 GB");
    expect(formatBytesParts(1_300_000_000, "pt-BR")).toEqual({ value: "1,3", unit: "GB" });
    expect(formatBytes(1_234 * GB, "en")).toBe("1,234 GB");
  });
});

const GB = 1000 ** 3;
