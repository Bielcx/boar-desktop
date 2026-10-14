import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { onPageGone, type HandlerContext } from "./context";

/**
 * "ApiServer" (Settings > Local API server): BOAR's library and answers over HTTP for other programs on this computer,
 * OpenAI-compatible, behind tokens (as LM Studio's server, minus its gaps). Off by default. Main does the door: it
 * listens on 127.0.0.1 only, refuses a Host other than its own (DNS rebinding) and any browser page (Origin), checks
 * the token and the rate; only then is the request handed to the page, which answers with the model it already has
 * loaded (src/services/apiServer.ts), so no second copy of the model is loaded. Tokens are shown once and stored as
 * SHA-256 hashes in <userData>/api-tokens.json. Notes: docs/10-api.md.
 */
export const DEFAULT_PORT = 41414;
/** Requests per token per minute. ponytail: one fixed limit; per-token limits if someone needs them. */
export const RATE_PER_MINUTE = 60;
const MAX_BODY = 1024 * 1024;
const PAGE_TIMEOUT_MS = 5 * 60_000;

export interface ApiServerConfig {
  enabled: boolean;
  port: number;
}

interface StoredToken {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. The token itself is never stored. */
  hash: string;
  /** "boar_Ab12…wxyz", to tell tokens apart in Settings. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}
export type TokenInfo = Omit<StoredToken, "hash">;

/** What the page answers with (src/services/apiServer.ts); `chunk` streams a chat answer's text as it's written. */
export interface PageBridge {
  ready(): boolean;
  request(kind: "models" | "search" | "chat", body: unknown, chunk?: (text: string) => void): Promise<unknown>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function parseConfig(v: unknown): ApiServerConfig {
  const c = (v ?? {}) as Partial<ApiServerConfig>;
  const port = Number(c.port);
  return { enabled: c.enabled === true, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, code: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function apiServer(dataDir: string, page: PageBridge, now: () => number = Date.now) {
  const configFile = path.join(dataDir, "api-server.json");
  const tokensFile = path.join(dataDir, "api-tokens.json");
  const tokens = (): StoredToken[] => readJson<StoredToken[]>(tokensFile, []).filter((t) => typeof t?.hash === "string");
  const info = ({ hash: _, ...t }: StoredToken): TokenInfo => t;
  const hits = new Map<string, number[]>();
  let server: Server | null = null;
  let listening: { port: number } | null = null;
  let lastError: string | null = null;

  /** The token behind an Authorization: Bearer / x-api-key header, if it's valid and not expired. */
  function authenticate(req: IncomingMessage): StoredToken {
    const auth = req.headers.authorization;
    const given = (typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : req.headers["x-api-key"])?.toString().trim();
    if (!given) throw new HttpError(401, "Missing API token: send Authorization: Bearer <token>.", "missing_token", { "WWW-Authenticate": "Bearer" });
    const h = sha256(given);
    // Every stored hash is compared, in constant time, so the timing says nothing about which one is close.
    let match: StoredToken | undefined;
    for (const t of tokens()) if (timingSafeEqual(h, Buffer.from(t.hash, "hex")) && !match) match = t;
    if (!match) throw new HttpError(401, "Invalid API token.", "invalid_token", { "WWW-Authenticate": "Bearer" });
    if (match.expiresAt !== null && match.expiresAt <= now()) throw new HttpError(401, "This API token has expired.", "expired_token");
    return match;
  }

  function rateLimit(id: string): void {
    const t = now();
    const recent = (hits.get(id) ?? []).filter((x) => x > t - 60_000);
    if (recent.length >= RATE_PER_MINUTE) {
      const retry = Math.ceil((recent[0] + 60_000 - t) / 1000);
      throw new HttpError(429, `Too many requests: at most ${RATE_PER_MINUTE} a minute per token.`, "rate_limited", { "Retry-After": String(retry) });
    }
    recent.push(t);
    hits.set(id, recent);
  }

  function touch(id: string): void {
    const all = tokens();
    const t = all.find((x) => x.id === id);
    if (t) {
      t.lastUsedAt = now();
      writeJson(tokensFile, all);
    }
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send a JSON body (Content-Type: application/json).", "unsupported_media_type");
    let size = 0;
    const parts: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "The request body is over 1 MB.", "body_too_large");
      parts.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new HttpError(400, "The body isn't valid JSON.", "invalid_json");
    }
  }

  async function ask(kind: "models" | "search" | "chat", body: unknown, chunk?: (t: string) => void): Promise<unknown> {
    if (!page.ready()) throw new HttpError(503, "BOAR isn't ready: open the app (it can stay in the tray).", "not_ready");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.request(kind, body, chunk),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new HttpError(504, "BOAR took too long to answer.", "timeout")), PAGE_TIMEOUT_MS))),
      ]);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      if (/locked/i.test(message)) throw new HttpError(423, "BOAR is locked: enter the PIN in the app.", "locked");
      throw new HttpError(400, message, "bad_request");
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    // Only this computer's programs, by name: a web page that resolves its own domain to 127.0.0.1 (DNS rebinding)
    // still sends its own Host, and any browser page sends an Origin.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "Wrong Host header.", "forbidden_host");
    if (req.headers.origin !== undefined) throw new HttpError(403, "Requests from web pages aren't allowed.", "forbidden_origin");
    const token = authenticate(req);
    rateLimit(token.id);
    touch(token.id);

    const url = new URL(req.url ?? "/", `http://${host}`);
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (route === "GET /v1/models") return send(res, 200, await ask("models", null));
    if (route === "POST /v1/library/search") return send(res, 200, await ask("search", await readBody(req)));
    if (route === "POST /v1/chat/completions") {
      const body = (await readBody(req)) as { stream?: unknown };
      if (body?.stream !== true) return send(res, 200, await ask("chat", body));
      // Server-sent events, as OpenAI's streaming: one chunk per piece of text, then the final one and [DONE].
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(now() / 1000);
      const event = (delta: object, finish: string | null, extra: object = {}) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "boar", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      event({ role: "assistant" }, null);
      let streamed = "";
      try {
        const done = (await ask("chat", body, (text) => {
          streamed += text;
          event({ content: text }, null);
        })) as { choices?: Array<{ message?: { content?: string } }>; boar_sources?: unknown };
        // Not every answer is written token by token: a decline or a card comes whole at the end, and the source check
        // can still change a streamed answer. Nothing streamed: the text goes now. Changed: the final one is boar_text.
        const final = done?.choices?.[0]?.message?.content ?? "";
        if (!streamed && final) event({ content: final }, null);
        event({}, "stop", { boar_sources: done?.boar_sources ?? [], ...(streamed && final !== streamed ? { boar_text: final } : {}) });
      } catch (e) {
        const err = e instanceof HttpError ? e : new HttpError(500, String(e), "internal_error");
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: err.code, code: err.code } })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    throw new HttpError(404, `No route ${route}. See GET /v1/models, POST /v1/chat/completions, POST /v1/library/search.`, "not_found");
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  async function apply(): Promise<void> {
    const c = parseConfig(readJson(configFile, {}));
    if (server && (!c.enabled || listening?.port !== c.port)) {
      const old = server;
      await new Promise((r) => {
        old.close(r);
        old.closeAllConnections(); // turned off means off, including clients keeping a connection open
      });
      server = null;
      listening = null;
    }
    if (!c.enabled || server) return;
    const s = createServer((req, res) => {
      handle(req, res, c.port).catch((e) => {
        const err = e instanceof HttpError ? e : new HttpError(500, "Internal error.", "internal_error");
        if (res.headersSent) return res.end();
        send(res, err.status, { error: { message: err.message, type: err.code, code: err.code } }, err.headers);
      });
    });
    server = s;
    await new Promise<void>((resolve) => {
      s.once("error", (e: NodeJS.ErrnoException) => {
        lastError = e.code === "EADDRINUSE" ? `Port ${c.port} is in use by another program.` : e.message;
        server = null;
        resolve();
      });
      s.listen(c.port, "127.0.0.1", () => {
        lastError = null;
        listening = { port: c.port };
        resolve();
      });
    });
  }

  return {
    apply,
    status: () => ({ ...parseConfig(readJson(configFile, {})), running: listening !== null, error: lastError, tokens: tokens().map(info) }),
    async set(value: unknown) {
      writeJson(configFile, parseConfig(value));
      await apply();
    },
    /** A new token, returned once in full; only its hash is kept. `days`: null never expires. */
    createToken(name: unknown, days: unknown): { token: string; info: TokenInfo } {
      const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "API token";
      const d = days === null || days === undefined ? null : Number(days);
      if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 3650)) throw new Error("Expiry must be 1 to 3650 days, or never.");
      const token = `boar_${randomBytes(32).toString("base64url")}`;
      const t: StoredToken = {
        id: randomUUID(),
        name: label,
        hash: sha256(token).toString("hex"),
        hint: `${token.slice(0, 9)}…${token.slice(-4)}`,
        createdAt: now(),
        lastUsedAt: null,
        expiresAt: d === null ? null : now() + d * 86_400_000,
      };
      writeJson(tokensFile, [...tokens(), t]);
      return { token, info: info(t) };
    },
    revokeToken(id: unknown): void {
      writeJson(tokensFile, tokens().filter((t) => t.id !== id));
      hits.delete(String(id));
    },
    close: () =>
      new Promise<void>((r) => {
        if (!server) return r();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export function register(ctx: HandlerContext): void {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunk?: (t: string) => void }>();
  let pageReady = false;
  const page: PageBridge = {
    ready: () => pageReady && ctx.webContents() !== null,
    request: (kind, body, chunk) =>
      new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, { resolve, reject, chunk });
        ctx.send("api-server:request", { id, kind, body, stream: chunk !== undefined });
      }),
  };
  const server = apiServer(path.dirname(ctx.roots.document), page);
  void server.apply();

  ctx.ipcMain.handle("api-server:get", () => server.status());
  ctx.ipcMain.handle("api-server:set", async (_e, value: unknown) => {
    await server.set(value);
    return server.status();
  });
  ctx.ipcMain.handle("api-server:createToken", (_e, name: unknown, days: unknown) => server.createToken(name, days));
  ctx.ipcMain.handle("api-server:revokeToken", (_e, id: unknown) => {
    server.revokeToken(id);
    return server.status();
  });
  // The page's side of a request: it's listening, a piece of a streamed answer, the result.
  ctx.ipcMain.handle("api-server:ready", (e) => {
    pageReady = true;
    // A reloaded or closed page can't answer what it was asked: those requests fail, and new ones wait for it.
    onPageGone(e.sender, () => {
      pageReady = false;
      for (const p of pending.values()) p.reject(new Error("BOAR's page reloaded; try again."));
      pending.clear();
    });
  });
  ctx.ipcMain.handle("api-server:chunk", (_e, id: string, text: string) => {
    if (typeof text === "string") pending.get(id)?.chunk?.(text);
  });
  ctx.ipcMain.handle("api-server:reply", (_e, id: string, reply: { ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (reply?.ok) p.resolve(reply.result);
    else p.reject(new Error(typeof reply?.error === "string" ? reply.error : "The request failed."));
  });
}
