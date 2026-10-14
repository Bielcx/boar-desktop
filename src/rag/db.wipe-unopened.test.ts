import { describe, it, expect, vi } from "vitest";

const { log } = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async () => {
    log.push("open");
    return {
      execAsync: async (sql: string) => void (/DELETE/.test(sql) && log.push(sql.trim())),
      runAsync: async () => ({ changes: 0 }),
      getAllAsync: async (sql: string) => (/sqlite_master/.test(sql) ? [{ name: "chat_messages", sql: "CREATE TABLE chat_messages (id TEXT)" }] : []),
      getFirstAsync: async () => null,
      withTransactionAsync: async (task: () => Promise<void>) => task(),
      closeAsync: async () => void log.push("close"),
    };
  },
  deleteDatabaseAsync: async () => void log.push("deleteDatabase"),
}));

import { wipeDatabase } from "./db";

describe("wipeDatabase before anything opened the database", () => {
  it("opens it and still deletes the data", async () => {
    await wipeDatabase();
    expect(log).toEqual(["open", 'DELETE FROM "chat_messages"']);
  });
});
