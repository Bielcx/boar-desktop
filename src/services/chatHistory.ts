import { getDb, writeTransaction } from "../rag/db";
import { repairedTitle } from "./sessionTitle.pure";
import { isSealed, LOCKED, lockedCipher, plainCipher, type TextCipher } from "../security/textCipher";

/**
 * How chat text reaches the database: plain, or sealed with the PIN's data key (src/security/textCipher.ts). Every
 * title, summary, message and its meta goes through it; ids, times and ratings stay plain. Set by the PIN lock.
 */
let cipher: TextCipher = plainCipher;
export function setChatCipher(c: TextCipher): void {
  cipher = c;
}

/** Whether a PIN is set and not entered yet (the local API refuses requests meanwhile). */
export const chatsLocked = (): boolean => cipher === lockedCipher;

export interface ChatSession {
  id: string;
  title: string;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
  /** The agent profile it was started with (chat_session_scope), if any. */
  profileId?: string;
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  /** null = no rating given. Present so reopening a past session restores previously-given thumbs. */
  feedback: "up" | "down" | null;
  /** JSON the chat stores with an answer (sources, receipt, outcome); null for older messages and user turns. */
  meta: string | null;
}

// Sources and receipt of each answer, kept apart from chat_messages so the
// shared schema in src/rag/db.ts stays untouched. Created on first use.
let metaTableReady: Promise<void> | null = null;
function ensureMetaTable(): Promise<void> {
  metaTableReady ??= getDb()
    .then((db) =>
      db.execAsync(
        `CREATE TABLE IF NOT EXISTS chat_message_meta (
           message_id TEXT PRIMARY KEY REFERENCES chat_messages(id),
           meta TEXT NOT NULL
         )`
      )
    )
    .catch((e) => {
      metaTableReady = null;
      throw e;
    });
  return metaTableReady;
}

/**
 * What a conversation is limited to, saved with it: personal collections ("Ask this document") and the agent
 * profile it was started with. Own table, like chat_message_meta, so the shared schema stays untouched.
 */
export interface SessionScope {
  collections: string[];
  profileId?: string;
}

let scopeTableReady: Promise<void> | null = null;
function ensureScopeTable(): Promise<void> {
  scopeTableReady ??= getDb()
    .then((db) => db.execAsync(`CREATE TABLE IF NOT EXISTS chat_session_scope (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL)`))
    .catch((e) => {
      scopeTableReady = null;
      throw e;
    });
  return scopeTableReady;
}

export async function getSessionScope(sessionId: string): Promise<SessionScope | null> {
  await ensureScopeTable();
  const [row] = await (await getDb()).getAllAsync<{ scope: string }>(`SELECT scope FROM chat_session_scope WHERE session_id = ?`, [sessionId]);
  try {
    return row ? (JSON.parse(row.scope) as SessionScope) : null;
  } catch {
    return null;
  }
}

/** null (or no collections and no profile) clears it. */
export async function setSessionScope(sessionId: string, scope: SessionScope | null): Promise<void> {
  await ensureScopeTable();
  const db = await getDb();
  if (!scope || (!scope.collections.length && !scope.profileId)) {
    await db.runAsync(`DELETE FROM chat_session_scope WHERE session_id = ?`, [sessionId]);
    return;
  }
  await db.runAsync(`INSERT OR REPLACE INTO chat_session_scope (session_id, scope) VALUES (?, ?)`, [sessionId, JSON.stringify(scope)]);
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSession(title = "New chat"): Promise<ChatSession> {
  const db = await getDb();
  const now = Date.now();
  const session: ChatSession = { id: newId(), title, summary: null, createdAt: now, updatedAt: now };
  await db.runAsync(
    `INSERT INTO chat_sessions (id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [session.id, await cipher.seal(session.title), session.summary, session.createdAt, session.updatedAt]
  );
  return session;
}

export async function listSessions(): Promise<ChatSession[]> {
  await ensureScopeTable();
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    title: string;
    summary: string | null;
    created_at: number;
    updated_at: number;
    scope: string | null;
  }>(
    `SELECT s.id, s.title, s.summary, s.created_at, s.updated_at, sc.scope FROM chat_sessions s
     LEFT JOIN chat_session_scope sc ON sc.session_id = s.id ORDER BY s.updated_at DESC`
  );
  const profileOf = (scope: string | null) => {
    try {
      return scope ? (JSON.parse(scope) as SessionScope).profileId : undefined;
    } catch {
      return undefined;
    }
  };
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      title: await cipher.open(r.title),
      summary: r.summary === null ? null : await cipher.open(r.summary),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      profileId: profileOf(r.scope),
    }))
  );
}

export async function getMessages(sessionId: string): Promise<ChatMessageRecord[]> {
  await ensureMetaTable();
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    session_id: string;
    role: "user" | "assistant";
    text: string;
    created_at: number;
    rating: "up" | "down" | null;
    meta: string | null;
  }>(
    `SELECT m.id, m.session_id, m.role, m.text, m.created_at, f.rating, x.meta
     FROM chat_messages m
     LEFT JOIN answer_feedback f ON f.message_id = m.id
     LEFT JOIN chat_message_meta x ON x.message_id = m.id
     WHERE m.session_id = ? ORDER BY m.created_at ASC`,
    [sessionId]
  );
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      text: await cipher.open(r.text),
      createdAt: r.created_at,
      feedback: r.rating,
      meta: r.meta == null ? null : await cipher.open(r.meta),
    }))
  );
}

/** Stores (or replaces) the chat's JSON for an answer. */
export async function setMessageMeta(messageId: string, meta: string): Promise<void> {
  await ensureMetaTable();
  const db = await getDb();
  await db.runAsync(`INSERT OR REPLACE INTO chat_message_meta (message_id, meta) VALUES (?, ?)`, [messageId, await cipher.seal(meta)]);
}

/**
 * `id` is optional and defaults to a freshly generated one, but ChatScreen
 * always passes its own in-memory message id explicitly (the same one used
 * as the FlatList key / React state id) — so a thumbs-up/down tap can
 * reference `item.id` directly as `setMessageFeedback`'s foreign key,
 * rather than needing a separate id-mapping step.
 */
export async function addMessage(
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  id: string = newId()
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO chat_messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, sessionId, role, await cipher.seal(text), now]
  );
  await db.runAsync(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
}

/**
 * Saves a message, or updates the text of one saved before (an answer retried
 * in place keeps its id and position).
 */
export async function upsertMessage(sessionId: string, role: "user" | "assistant", text: string, id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO chat_messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
    [id, sessionId, role, await cipher.seal(text), now]
  );
  await db.runAsync(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
}

/** `rating: null` clears any existing feedback (tapping the same thumb again to un-rate). */
export async function setMessageFeedback(messageId: string, rating: "up" | "down" | null): Promise<void> {
  const db = await getDb();
  if (rating === null) {
    await db.runAsync(`DELETE FROM answer_feedback WHERE message_id = ?`, [messageId]);
    return;
  }
  await db.runAsync(
    `INSERT OR REPLACE INTO answer_feedback (message_id, rating, created_at) VALUES (?, ?, ?)`,
    [messageId, rating, Date.now()]
  );
}

/** Titles written as "<think>…" by a reasoning model before titles skipped it (the native app's 0c42a1a4). */
export async function repairThinkingTitles(): Promise<number> {
  let repaired = 0;
  for (const s of await listSessions()) {
    if (!s.title.includes("think>")) continue;
    const first = (await getMessages(s.id)).find((m) => m.role === "user")?.text;
    const title = repairedTitle(s.title, first);
    if (title !== null) {
      await setSessionTitle(s.id, title);
      repaired++;
    }
  }
  return repaired;
}

export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE chat_sessions SET title = ? WHERE id = ?`, [await cipher.seal(title), sessionId]);
}

export async function setSessionSummary(sessionId: string, summary: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE chat_sessions SET summary = ? WHERE id = ?`, [await cipher.seal(summary), sessionId]);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await ensureMetaTable();
  await ensureScopeTable();
  await writeTransaction(async (txn) => {
    await txn.runAsync(`DELETE FROM chat_session_scope WHERE session_id = ?`, [sessionId]);
    await txn.runAsync(
      `DELETE FROM chat_message_meta WHERE message_id IN (SELECT id FROM chat_messages WHERE session_id = ?)`,
      [sessionId]
    );
    await txn.runAsync(
      `DELETE FROM answer_feedback WHERE message_id IN (SELECT id FROM chat_messages WHERE session_id = ?)`,
      [sessionId]
    );
    await txn.runAsync(`DELETE FROM chat_messages WHERE session_id = ?`, [sessionId]);
    await txn.runAsync(`DELETE FROM chat_sessions WHERE id = ?`, [sessionId]);
  });
}

export async function clearAllHistory(): Promise<void> {
  await ensureMetaTable();
  await ensureScopeTable();
  await writeTransaction(async (txn) => {
    await txn.runAsync(`DELETE FROM chat_session_scope`);
    await txn.runAsync(`DELETE FROM chat_message_meta`);
    await txn.runAsync(`DELETE FROM answer_feedback`);
    await txn.runAsync(`DELETE FROM chat_messages`);
    await txn.runAsync(`DELETE FROM chat_sessions`);
  });
}

/** Deletes the oldest sessions beyond `maxSessions` (0 = unlimited). */
export async function pruneSessions(maxSessions: number): Promise<void> {
  if (maxSessions <= 0) return;
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT -1 OFFSET ?`,
    [maxSessions]
  );
  for (const row of rows) {
    await deleteSession(row.id);
  }
}

/**
 * Re-seals every stored chat text from one cipher to another in one transaction (turning the PIN on or off), then
 * rewrites the file (VACUUM) so the old text doesn't linger in freed pages or the WAL. Opened with `from`, so a value
 * `from` can't open (sealed with a lost key) is kept as is.
 */
export async function resealAllChats(from: TextCipher, to: TextCipher): Promise<void> {
  await ensureMetaTable();
  const db = await getDb();
  const sessions = await db.getAllAsync<{ id: string; title: string; summary: string | null }>(`SELECT id, title, summary FROM chat_sessions`);
  const messages = await db.getAllAsync<{ id: string; text: string }>(`SELECT id, text FROM chat_messages`);
  const metas = await db.getAllAsync<{ message_id: string; meta: string }>(`SELECT message_id, meta FROM chat_message_meta`);
  const re = async (v: string) => {
    const plain = await from.open(v);
    return isSealed(v) && plain === LOCKED ? v : to.seal(plain);
  };
  const updates: Array<[string, unknown[]]> = [];
  for (const r of sessions)
    updates.push([`UPDATE chat_sessions SET title = ?, summary = ? WHERE id = ?`, [await re(r.title), r.summary === null ? null : await re(r.summary), r.id]]);
  for (const r of messages) updates.push([`UPDATE chat_messages SET text = ? WHERE id = ?`, [await re(r.text), r.id]]);
  for (const r of metas) updates.push([`UPDATE chat_message_meta SET meta = ? WHERE message_id = ?`, [await re(r.meta), r.message_id]]);
  await writeTransaction(async (txn) => {
    for (const [sql, args] of updates) await txn.runAsync(sql, args as any[]);
  });
  await db.execAsync(`PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);`);
}
