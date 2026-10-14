import { describe, it, expect, vi } from "vitest";

const { log, conns } = vi.hoisted(() => ({ log: [] as string[], conns: [] as any[] }));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async () => {
    const n = conns.length + 1;
    let release: () => void = () => {};
    const conn = {
      n,
      finishRead: () => release(),
      execAsync: async (sql: string) => void (/DELETE|VACUUM|defer_foreign_keys|wal_checkpoint/.test(sql) && log.push(sql.trim())),
      runAsync: async () => ({ changes: 0 }),
      getAllAsync: async (sql: string) =>
        /sqlite_master/.test(sql)
          ? [
              { name: "chunks_fts", sql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(title, body)" },
              { name: "chunks_fts_data", sql: "CREATE TABLE 'chunks_fts_data'(id INTEGER PRIMARY KEY, block BLOB)" },
              { name: "chunks", sql: "CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY)" },
              { name: "chat_messages", sql: "CREATE TABLE chat_messages (id TEXT PRIMARY KEY)" },
            ]
          : [],
      getFirstAsync: (sql: string) =>
        /slow/.test(sql) ? new Promise((resolve) => (release = () => (log.push("read done"), resolve({ ok: 1 })))) : Promise.resolve({ ok: 1 }),
      withTransactionAsync: async (task: () => Promise<void>) => {
        log.push("BEGIN");
        await task();
        log.push("COMMIT");
      },
      closeAsync: async () => void log.push(`close ${n}`),
    };
    conns.push(conn);
    return conn;
  },
  deleteDatabaseAsync: async () => void log.push("deleteDatabase"),
}));

import { getDb, resetDatabase, wipeDatabase } from "./db";
import { runResetHooks } from "../services/resetOrder";

describe("wipeDatabase (RS-1 v2)", () => {
  it("empties every data table on the open connection, never closes or deletes it, and the kept handle still works", async () => {
    const db = await getDb();
    const read = db.getFirstAsync("SELECT slow");
    const first = wipeDatabase();
    const second = resetDatabase();
    conns[0].finishRead();
    await Promise.all([first, second, read]);
    expect(log).toEqual([
      "read done",
      "BEGIN",
      "PRAGMA defer_foreign_keys = ON",
      'DELETE FROM "chunks_fts"',
      'DELETE FROM "chunks"',
      'DELETE FROM "chat_messages"',
      "COMMIT",
      "VACUUM",
      "PRAGMA wal_checkpoint(TRUNCATE)",
    ]);
    expect(log.some((l) => /close|deleteDatabase/.test(l))).toBe(false);
    expect(await db.getFirstAsync("SELECT 1")).toEqual({ ok: 1 });
    expect(await getDb()).toBe(db);
    expect(conns).toHaveLength(1);
  });

  it("is the required 'knowledge-base' wipe hook", async () => {
    log.length = 0;
    await runResetHooks("wipe", ["knowledge-base"]);
    expect(log).toContain('DELETE FROM "chunks"');
  });
});
