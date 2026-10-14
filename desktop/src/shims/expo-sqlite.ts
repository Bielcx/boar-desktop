// Desktop shim for "expo-sqlite". See shared/bridge.ts.
// The connection lives in the main process (desktop/src/main/handlers/expo-sqlite.ts, node:sqlite); this object only
// holds its id. Only the subset of SQLiteDatabase the app calls is here.
import { native } from "../shared/bridge";

export type SQLiteBindValue = string | number | null | boolean | Uint8Array;
export type SQLiteBindParams = SQLiteBindValue[] | Record<string, SQLiteBindValue>;

export interface SQLiteRunResult {
  lastInsertRowId: number;
  changes: number;
}

export interface SQLiteOpenOptions {
  useNewConnection?: boolean;
}

const call = <T>(method: string, ...args: unknown[]) => native().invoke<T>(`expo-sqlite:${method}`, ...args);

// expo accepts runAsync(sql, [a, b]), runAsync(sql, {$a: 1}) and runAsync(sql, a, b).
const params = (args: unknown[]) => (args.length === 1 && args[0] !== null && typeof args[0] === "object" && !(args[0] instanceof Uint8Array) ? args[0] : args);

export class SQLiteDatabase {
  /** Transactions on this connection, one after another (see withTransactionAsync). */
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly databasePath: string,
    private readonly id: number
  ) {}

  execAsync(source: string): Promise<void> {
    return call("exec", this.id, source);
  }

  runAsync(source: string, ...args: unknown[]): Promise<SQLiteRunResult> {
    return call("run", this.id, source, params(args));
  }

  getAllAsync<T>(source: string, ...args: unknown[]): Promise<T[]> {
    return call("all", this.id, source, params(args));
  }

  getFirstAsync<T>(source: string, ...args: unknown[]): Promise<T | null> {
    return call("first", this.id, source, params(args));
  }

  /**
   * BEGIN, the task, then COMMIT (or ROLLBACK if it throws), as expo does. The task's own calls are separate IPC
   * messages, so as on Android any other call on this connection made meanwhile also lands inside the transaction.
   * Unlike Android, a second withTransactionAsync waits for the first instead of failing with "cannot start a
   * transaction within a transaction". A transaction that calls withTransactionAsync again would wait forever (Android
   * throws); the app never nests them.
   */
  withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const run = this.txQueue.then(async () => {
      await this.execAsync("BEGIN");
      try {
        await task();
        await this.execAsync("COMMIT");
      } catch (e) {
        await this.execAsync("ROLLBACK").catch(() => {});
        throw e;
      }
    });
    this.txQueue = run.catch(() => {});
    return run;
  }

  closeAsync(): Promise<void> {
    return call("close", this.id);
  }
}

/**
 * Opens databaseName in `directory` (default: documentDirectory + "SQLite", like expo). `directory` may be a file:// URI
 * or a plain absolute path (src/rag/packs.ts strips "file://"). Every open is a new connection, so useNewConnection is
 * implied.
 */
export async function openDatabaseAsync(databaseName: string, _options?: SQLiteOpenOptions, directory?: string): Promise<SQLiteDatabase> {
  let dir = directory ?? `${native().dirs.document}SQLite`;
  if (!dir.startsWith("file://")) dir = (dir.startsWith("/") ? "file://" : "file:///") + dir.replace(/\\/g, "/");
  const uri = `${dir.replace(/\/+$/, "")}/${databaseName}`;
  return new SQLiteDatabase(uri, await call<number>("open", uri));
}
