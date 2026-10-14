import { describe, it, expect, vi } from "vitest";

const { conns } = vi.hoisted(() => ({ conns: [] as any[] }));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async () => {
    let release: () => void = () => {};
    const conn = {
      finish: () => release(),
      execAsync: async () => {},
      runAsync: (sql: string) => (/slow/.test(sql) ? new Promise((r) => (release = () => r({ changes: 1 }))) : Promise.resolve({ changes: 1 })),
      getAllAsync: async () => [],
      getFirstAsync: async () => null,
      withTransactionAsync: async (task: () => Promise<void>) => task(),
      closeAsync: async () => {},
    };
    conns.push(conn);
    return conn;
  },
  deleteDatabaseAsync: async () => {},
}));

import { getDb, resetDatabase, writeTransaction } from "./db";

describe("reset with a write queued behind a running one", () => {
  it("finishes (no deadlock)", async () => {
    await getDb();
    const w1 = writeTransaction(async (db) => void (await db.runAsync("INSERT slow")));
    const w2 = writeTransaction(async (db) => void (await db.runAsync("INSERT next")));
    await new Promise((r) => setTimeout(r, 0));
    const reset = resetDatabase();
    conns[0].finish();
    const outcome = await Promise.race([
      reset.then(() => "reset done"),
      new Promise((r) => setTimeout(() => r("TIMEOUT (deadlock)"), 1000)),
    ]);
    await Promise.allSettled([w1, w2]);
    expect(outcome).toBe("reset done");
  });
});
