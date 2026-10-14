import { beforeEach, describe, expect, it, vi } from "vitest";

// Two tiles on "disk": one SQLite can't read, one that hits a transient error.
const files = new Set<string>();
const errors = new Map<string, string>([
  ["t-N41E012.sqlite", "Error code 26: file is not a database"],
  ["t-N42E012.sqlite", "database is locked"],
]);

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: async () => ({ exists: false }),
  readDirectoryAsync: async () => [...files].map((p) => p.replace(/^.*\//, "")),
  deleteAsync: async (uri: string) => {
    files.delete(uri);
  },
}));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async (name: string) => {
    throw new Error(errors.get(name) ?? "unexpected open");
  },
}));

import { forgetAllPoiPacks, installedPoiAreas, isUnreadableTile } from "./pois";

beforeEach(async () => {
  await forgetAllPoiPacks();
  files.clear();
  files.add("file:///docs/poi/t-N41E012.sqlite");
  files.add("file:///docs/poi/t-N42E012.sqlite");
});

describe("a places tile that fails to open", () => {
  it("is deleted when it is corrupt, kept when the error is transient", async () => {
    const areas = await installedPoiAreas();
    for (const a of areas) await a.within({ lat: 41.9, lon: 12.5 } as any, 1000);
    expect([...files]).toEqual(["file:///docs/poi/t-N42E012.sqlite"]);
  });

  it("only tiles, only corruption", () => {
    expect(isUnreadableTile("t-N41E012.sqlite", new Error("not a places pack"))).toBe(true);
    expect(isUnreadableTile("t-N41E012.sqlite", new Error("database disk image is malformed"))).toBe(true);
    expect(isUnreadableTile("t-N41E012.sqlite", new Error("database is locked"))).toBe(false);
    expect(isUnreadableTile("europe-south.sqlite", new Error("file is not a database"))).toBe(false);
    expect(isUnreadableTile("world-places.sqlite", new Error("file is not a database"))).toBe(false);
  });
});
