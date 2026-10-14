/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";

/**
 * The subset of expo-sqlite's SQLiteDatabase this app calls, backed by
 * Node's built-in node:sqlite, so database code runs for real in vitest.
 * Test-only: nothing in the app imports this.
 */
export function nodeSqliteDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  const params = (p?: unknown[]) => (p ?? []) as any[];
  return {
    raw: db,
    async execAsync(sql: string) {
      db.exec(sql);
    },
    async getAllAsync<T>(sql: string, p?: unknown[]): Promise<T[]> {
      return db.prepare(sql).all(...params(p)) as T[];
    },
    async getFirstAsync<T>(sql: string, p?: unknown[]): Promise<T | null> {
      return (db.prepare(sql).get(...params(p)) as T | undefined) ?? null;
    },
    async runAsync(sql: string, p?: unknown[]) {
      const r = db.prepare(sql).run(...params(p));
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async withTransactionAsync(work: () => Promise<void>) {
      db.exec("BEGIN");
      try {
        await work();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async closeAsync() {
      db.close();
    },
  };
}
