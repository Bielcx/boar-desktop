// The local API's door (src/main/handlers/api-server.ts) over real HTTP, with a stand-in page: off by default, tokens
// (hashed, expiring, revocable, Bearer or x-api-key), Host and Origin checks, the rate limit, streaming, and a
// locked or absent page.
import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiServer, RATE_PER_MINUTE, type PageBridge } from "../src/main/handlers/api-server";

const port = 40000 + Math.floor(Math.random() * 9000);
let open: ReturnType<typeof apiServer> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

function setup(page: Partial<PageBridge> = {}, now = () => Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), "boar-api-"));
  const bridge: PageBridge = {
    ready: () => true,
    request: async (kind, body, chunk) => {
      if (kind === "chat" && chunk) ["Hello", ", ", "boar"].forEach(chunk);
      return { kind, body, boar_sources: [{ title: "Boar" }] };
    },
    ...page,
  };
  open = apiServer(dir, bridge, now);
  return { dir, api: open };
}

/** A raw request, so the Host and Origin headers are exactly what a test says. */
function call(path: string, headers: Record<string, string> = {}, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("local API server", () => {
  it("is off by default; on, it answers only with a valid token, Bearer or x-api-key", async () => {
    const { dir, api } = setup();
    await api.apply();
    expect(api.status()).toMatchObject({ enabled: false, running: false });
    await expect(call("/v1/models")).rejects.toThrow(); // nothing listening

    await api.set({ enabled: true, port });
    expect(api.status()).toMatchObject({ enabled: true, running: true, port });
    const { token, info } = api.createToken("Script", null);
    expect(token).toMatch(/^boar_[A-Za-z0-9_-]{43}$/);
    expect(info.hint).toBe(`${token.slice(0, 9)}…${token.slice(-4)}`);

    const none = await call("/v1/models");
    expect(none.status).toBe(401);
    expect(none.headers["www-authenticate"]).toBe("Bearer");
    expect((await call("/v1/models", bearer("boar_wrong"))).status).toBe(401);
    expect(JSON.parse((await call("/v1/models", bearer(token))).text)).toMatchObject({ kind: "models" });
    expect((await call("/v1/models", { "x-api-key": token })).status).toBe(200);
    expect(api.status().tokens[0].lastUsedAt).not.toBeNull();

    // Only the hash is kept.
    const file = readFileSync(join(dir, "api-tokens.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).not.toContain(token.slice(9, -4));
  });

  it("refuses another Host (DNS rebinding) and any browser page (Origin), even with the token", async () => {
    const { api } = setup();
    await api.set({ enabled: true, port });
    const { token } = api.createToken("t", null);
    expect((await call("/v1/models", { ...bearer(token), Host: `evil.example:${port}` })).status).toBe(403);
    expect((await call("/v1/models", { ...bearer(token), Origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/v1/models", { ...bearer(token), Host: `localhost:${port}` })).status).toBe(200);
  });

  it("an expired or revoked token stops working", async () => {
    let t = 1_000_000_000_000;
    const { api } = setup({}, () => t);
    await api.set({ enabled: true, port });
    const week = api.createToken("week", 7);
    const forever = api.createToken("forever", null);
    expect((await call("/v1/models", bearer(week.token))).status).toBe(200);
    t += 8 * 86_400_000;
    expect((await call("/v1/models", bearer(week.token))).status).toBe(401);
    expect((await call("/v1/models", bearer(forever.token))).status).toBe(200);
    api.revokeToken(forever.info.id);
    expect((await call("/v1/models", bearer(forever.token))).status).toBe(401);
    expect(() => api.createToken("x", 0)).toThrow(/days/);
  });

  it(`allows ${RATE_PER_MINUTE} requests a minute per token, then 429 with Retry-After`, async () => {
    const { api } = setup();
    await api.set({ enabled: true, port });
    const a = api.createToken("a", null).token;
    const b = api.createToken("b", null).token;
    for (let i = 0; i < RATE_PER_MINUTE; i++) expect((await call("/v1/models", bearer(a))).status).toBe(200);
    const over = await call("/v1/models", bearer(a));
    expect(over.status).toBe(429);
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    expect((await call("/v1/models", bearer(b))).status).toBe(200); // per token
  });

  it("chat completions: JSON, or streamed as server-sent events ending in [DONE]", async () => {
    const { api } = setup();
    await api.set({ enabled: true, port });
    const { token } = api.createToken("t", null);
    const msg = { messages: [{ role: "user", content: "Hi" }] };
    expect(JSON.parse((await call("/v1/chat/completions", bearer(token), msg)).text)).toMatchObject({ kind: "chat", body: msg });
    const sse = await call("/v1/chat/completions", bearer(token), { ...msg, stream: true });
    expect(sse.headers["content-type"]).toBe("text/event-stream");
    const events = sse.text.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const text = events.slice(0, -1).map((e) => JSON.parse(e).choices[0].delta.content ?? "").join("");
    expect(text).toBe("Hello, boar");
    expect(JSON.parse(events.at(-2)!)).toMatchObject({ choices: [{ finish_reason: "stop" }], boar_sources: [{ title: "Boar" }] });
  });

  it("an answer that wasn't written token by token (a decline) still reaches a streaming client", async () => {
    const { api } = setup({ request: async () => ({ choices: [{ message: { content: "I didn't find this." } }], boar_sources: [] }) });
    await api.set({ enabled: true, port });
    const { token } = api.createToken("t", null);
    const sse = await call("/v1/chat/completions", bearer(token), { messages: [{ role: "user", content: "Hi" }], stream: true });
    const text = sse.text.split("\n\n").filter((e) => e && e !== "data: [DONE]").map((e) => JSON.parse(e.replace(/^data: /, "")).choices[0].delta.content ?? "").join("");
    expect(text).toBe("I didn't find this.");
  });

  it("bad requests, a page that isn't up, and a locked BOAR", async () => {
    let ready = false;
    const { api } = setup({ ready: () => ready, request: async () => { throw new Error("Chats are locked: enter the PIN first."); } });
    await api.set({ enabled: true, port });
    const { token } = api.createToken("t", null);
    expect((await call("/v1/models", bearer(token))).status).toBe(503);
    ready = true;
    expect((await call("/v1/models", bearer(token))).status).toBe(423);
    expect((await call("/v1/nope", bearer(token))).status).toBe(404);
    expect((await call("/v1/library/search", { ...bearer(token), "Content-Type": "text/plain" }, "x")).status).toBe(415);
  });
});
