import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { fileRoots, onPageGone, type HandlerContext } from "./context";
import { safePath } from "../storage/safePath";

/**
 * Main side of expo-sqlite, on Node's built-in node:sqlite. Connections live here, keyed by a numeric id the renderer
 * holds; each call is one synchronous node:sqlite call, so calls on a connection never interleave mid-statement.
 * Transactions are BEGIN/COMMIT/ROLLBACK sent by the shim (see its withTransactionAsync).
 *
 * A renderer that reloads mid-transaction would leave its connection holding the write lock, so when the page that
 * opened connections navigates away or is destroyed they're rolled back and closed.
 */
/**
 * The renderer sends raw SQL, so SQL must not reach files outside the one safePath allowed: ATTACH '<path>' and
 * VACUUM INTO '<path>' both go through SQLite's ATTACH authorizer with that filename, and are refused. Plain VACUUM
 * (src/rag/db.ts) attaches a temporary database named "", which stays allowed. trusted_schema=OFF keeps a crafted
 * database file's schema from running functions with side effects.
 */
function confine(d: DatabaseSync): void {
  d.setAuthorizer((action, filename) =>
    action === constants.SQLITE_ATTACH && filename !== "" ? constants.SQLITE_DENY : constants.SQLITE_OK
  );
  d.exec("PRAGMA trusted_schema = OFF");
}

export function register(ctx: HandlerContext): void {
  const dbs = new Map<number, DatabaseSync>();
  const owners = new WeakMap<object, Set<number>>();
  let nextId = 0;

  const db = (id: number) => {
    const d = dbs.get(id);
    if (!d) throw new Error(`database ${id} is closed`);
    return d;
  };
  const close = (id: number) => {
    const d = dbs.get(id);
    dbs.delete(id);
    if (d?.isOpen) {
      if (d.isTransaction) d.exec("ROLLBACK");
      d.close();
    }
  };
  // expo binds booleans as 0/1 and undefined as null; node:sqlite rejects both.
  const value = (v: unknown) => (typeof v === "boolean" ? Number(v) : v === undefined ? null : v);
  const bind = (params: unknown): any[] => {
    if (params == null) return [];
    if (Array.isArray(params)) return params.map(value);
    if (typeof params === "object" && (params as object).constructor === Object) {
      return [Object.fromEntries(Object.entries(params as object).map(([k, v]) => [k, value(v)]))];
    }
    return [value(params)];
  };
  const handle = (name: string, fn: (event: any, ...args: any[]) => unknown) => ctx.ipcMain.handle(`expo-sqlite:${name}`, fn);

  /** Opens `databaseUri` (a file:// URI the shim built from name + directory) and returns its id. */
  handle("open", (event, databaseUri: string) => {
    const file = safePath(fileRoots(ctx), databaseUri);
    if (!ctx.readOnly) mkdirSync(dirname(file), { recursive: true });
    // SQLite's own defaults, which is what expo-sqlite runs with (node:sqlite turns foreign keys on by default).
    const d = new DatabaseSync(file, {
      readOnly: ctx.readOnly === true,
      enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: true,
      allowExtension: false,
      defensive: true,
    });
    confine(d);
    const id = ++nextId;
    dbs.set(id, d);
    const sender = event?.sender;
    if (sender) {
      let ids = owners.get(sender);
      if (!ids) {
        const mine = new Set<number>();
        ids = mine;
        owners.set(sender, mine);
        onPageGone(sender, () => {
          for (const i of mine) close(i);
          mine.clear();
        });
      }
      ids.add(id);
    }
    return id;
  });
  handle("exec", (_e, id: number, sql: string) => void db(id).exec(sql));
  handle("run", (_e, id: number, sql: string, params?: unknown) => {
    const r = db(id).prepare(sql).run(...bind(params));
    return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
  });
  handle("all", (_e, id: number, sql: string, params?: unknown) => db(id).prepare(sql).all(...bind(params)));
  handle("first", (_e, id: number, sql: string, params?: unknown) => db(id).prepare(sql).get(...bind(params)) ?? null);
  handle("close", (_e, id: number) => close(id));
}
