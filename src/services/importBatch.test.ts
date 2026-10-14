import { describe, expect, it } from "vitest";
import { importBatch, type BatchResult } from "./importBatch";

class Unknown extends Error {}
const file = (name: string) => ({ name });

/** A fake catalog: the tile becomes known only once the gazetteer is installed. */
function fakeImport(log: string[]) {
  const known = new Set(["world-places.sqlite"]);
  return async (f: { name: string }) => {
    log.push(f.name);
    if (!known.has(f.name)) throw new Unknown(`${f.name} unknown`);
    if (f.name === "world-places.sqlite") known.add("t-N41E012.sqlite");
    return f.name;
  };
}

async function run(names: string[], importOne = fakeImport([])) {
  const results = new Map<string, BatchResult<string>>();
  await importBatch(names.map(file), importOne, { isUnknown: (e) => e instanceof Unknown, onResult: (f, r) => results.set(f.name, r) });
  return results;
}

describe("importBatch", () => {
  it("installs [tile, gazetteer] picked in that order (the gazetteer goes first)", async () => {
    const log: string[] = [];
    const r = await run(["t-N41E012.sqlite", "world-places.sqlite"], fakeImport(log));
    expect(r.get("world-places.sqlite")).toEqual({ ok: true, asset: "world-places.sqlite" });
    expect(r.get("t-N41E012.sqlite")).toEqual({ ok: true, asset: "t-N41E012.sqlite" });
    expect(log).toEqual(["world-places.sqlite", "t-N41E012.sqlite"]);
  });

  it("retries a file refused as unknown once something installed after it (gazetteer renamed by the user)", async () => {
    const log: string[] = [];
    const known = new Set(["places-copy.sqlite"]);
    const importOne = async (f: { name: string }) => {
      log.push(f.name);
      if (!known.has(f.name)) throw new Unknown("unknown");
      known.add("t-N41E012.sqlite");
      return f.name;
    };
    const r = await run(["t-N41E012.sqlite", "places-copy.sqlite"], importOne);
    expect(r.get("t-N41E012.sqlite")?.ok).toBe(true);
    expect(log).toEqual(["t-N41E012.sqlite", "places-copy.sqlite", "t-N41E012.sqlite"]);
  });

  it("does not retry when nothing was installed after the refusal, and reports other errors as they come", async () => {
    const log: string[] = [];
    const importOne = async (f: { name: string }) => {
      log.push(f.name);
      if (f.name === "broken.sqlite") throw new Error("hash-mismatch");
      throw new Unknown("unknown");
    };
    const r = await run(["stray.bin", "broken.sqlite"], importOne);
    expect(r.get("stray.bin")?.ok).toBe(false);
    expect(r.get("broken.sqlite")?.ok).toBe(false);
    expect(log).toEqual(["stray.bin", "broken.sqlite"]);
  });

  it("stops between files once aborted", async () => {
    const results: string[] = [];
    let n = 0;
    await importBatch([file("a"), file("b")], async (f) => f.name, { isUnknown: () => false, aborted: () => n++ > 0, onResult: (f) => results.push(f.name) });
    expect(results).toEqual(["a"]);
  });
});
