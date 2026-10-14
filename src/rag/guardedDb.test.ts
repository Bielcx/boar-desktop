import { describe, it, expect } from "vitest";
import { DbClosedError, guard } from "./guardedDb";

function fakeDb() {
  const log: string[] = [];
  let release: () => void = () => {};
  return {
    log,
    finish: () => release(),
    db: {
      getAllAsync: (sql: string) => {
        log.push(`start ${sql}`);
        return new Promise<string[]>((resolve) => (release = () => (log.push(`end ${sql}`), resolve([sql]))));
      },
      getFirstAsync: async (sql: string) => (log.push(`first ${sql}`), sql),
      closeAsync: async () => void log.push("close"),
    },
  };
}

describe("guard", () => {
  it("waits for calls in flight, then closes the native connection once", async () => {
    const f = fakeDb();
    const g = guard(f.db);
    const read = g.db.getAllAsync("SELECT 1");
    const closing = g.close();
    const again = g.close();
    expect(g.closing).toBe(true);
    expect(f.log).toEqual(["start SELECT 1"]);
    f.finish();
    expect(await read).toEqual(["SELECT 1"]);
    await Promise.all([closing, again]);
    expect(f.log).toEqual(["start SELECT 1", "end SELECT 1", "close"]);
  });

  it("rejects in JS any call made once closing, also through a handle saved earlier", async () => {
    const f = fakeDb();
    const g = guard(f.db, "knowledge base");
    const saved = g.db;
    await g.close();
    await expect(saved.getFirstAsync("SELECT 2")).rejects.toBeInstanceOf(DbClosedError);
    expect(f.log).toEqual(["close"]);
  });

  it("retire() and the handle's closeAsync() stop the connection in JS without closing it natively (RS-1)", async () => {
    const f = fakeDb();
    const a = guard(f.db);
    a.retire();
    await expect(a.db.getFirstAsync("SELECT 3")).rejects.toBeInstanceOf(DbClosedError);
    const b = guard(fakeDb().db);
    await b.db.closeAsync();
    await expect(b.db.getFirstAsync("SELECT 4")).rejects.toBeInstanceOf(DbClosedError);
    expect(f.log).not.toContain("close");
  });
});
