/**
 * The local API server's page side (desktop only): main (desktop/src/main/handlers/api-server.ts) checks the token,
 * Host, Origin and rate, then hands each request here, where it runs on the engine and the model the app already has
 * loaded. Generations queue behind the chat's (LlamaEngine runs one at a time). While BOAR is locked with a PIN, every
 * request is refused. Android's Expo app has no "ApiServer" module: apiServerAvailable() is false.
 */
import { requireOptionalNativeModule } from "expo-modules-core";
import { retrieve } from "../rag/retrieve";
import { listCustomCollections } from "../rag/db";
import { answer } from "../routing/answerService";
import type { AnswerEvent } from "../routing/events";
import type { RetrievedChunk } from "../rag/retrieve.types";
import { getActiveModelId, getMaxTokens, getPersonalityId } from "../models/settings";
import { MODEL_CATALOG } from "../models/manifest";
import { getPersonality } from "../constants/personalities";
import { chatsLocked } from "./chatHistory";

export interface ApiServerStatus {
  enabled: boolean;
  port: number;
  running: boolean;
  error: string | null;
  tokens: Array<{ id: string; name: string; hint: string; createdAt: number; lastUsedAt: number | null; expiresAt: number | null }>;
}

interface ApiRequest {
  id: string;
  kind: "models" | "search" | "chat";
  body: unknown;
  stream: boolean;
}

interface ApiServerModule {
  get(): Promise<ApiServerStatus>;
  set(config: { enabled: boolean; port: number }): Promise<ApiServerStatus>;
  createToken(name: string, days: number | null): Promise<{ token: string; info: ApiServerStatus["tokens"][number] }>;
  revokeToken(id: string): Promise<ApiServerStatus>;
  ready(): Promise<void>;
  chunk(id: string, text: string): Promise<void>;
  reply(id: string, reply: { ok: boolean; result?: unknown; error?: string }): Promise<void>;
  onRequest(listener: (req: unknown) => void): () => void;
}

export const apiServer = requireOptionalNativeModule<ApiServerModule>("ApiServer");
export const apiServerAvailable = (): boolean => apiServer !== null;

const MAX_QUERY = 2000;
const MAX_K = 20;
/** Earlier turns a chat request may carry into the prompt (the chat keeps 6 too). */
const HISTORY_TURNS = 6;

async function modelName(): Promise<string> {
  return (await getActiveModelId("llm")) ?? MODEL_CATALOG.find((m) => m.kind === "llm" && m.required)?.id ?? "boar";
}

async function passages(hits: RetrievedChunk[]) {
  const names = new Map((await listCustomCollections()).map((c) => [c.id, c.name]));
  return hits.map((h) => ({
    title: h.title,
    source: h.source ?? "",
    collection: h.collectionId ? (names.get(h.collectionId) ?? h.collectionId) : "Built-in library",
    similarity: h.similarity === undefined ? null : Math.round(h.similarity * 1000) / 1000,
    text: h.body,
  }));
}

/** OpenAI message content: a string, or text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && (p as any).type === "text" ? String((p as any).text ?? "") : "")).join("");
  return "";
}

async function search(body: unknown) {
  const b = (body ?? {}) as { query?: unknown; k?: unknown };
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (!query) throw new Error("query must be a non-empty string");
  if (query.length > MAX_QUERY) throw new Error(`query is longer than ${MAX_QUERY} characters`);
  const k = b.k === undefined ? 6 : Number(b.k);
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new Error(`k must be an integer from 1 to ${MAX_K}`);
  return { object: "list", data: await passages(await retrieve(query, k)) };
}

/**
 * OpenAI's chat completion on BOAR's grounded pipeline: the last user message is the question, earlier user and
 * assistant turns its history. A client's system message is ignored: BOAR answers its own way, from its sources,
 * and returns them in `boar_sources`.
 */
async function chat(body: unknown, chunk?: (text: string) => void) {
  const b = (body ?? {}) as { messages?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown };
  if (!Array.isArray(b.messages) || b.messages.length === 0) throw new Error("messages must be a non-empty array");
  const turns = b.messages
    .map((m: any) => ({ role: m?.role, text: textOf(m?.content).trim() }))
    .filter((m): m is { role: "user" | "assistant"; text: string } => (m.role === "user" || m.role === "assistant") && m.text.length > 0);
  const last = turns.at(-1);
  if (!last || last.role !== "user") throw new Error("the last message must be the user's");
  if (last.text.length > MAX_QUERY) throw new Error(`the question is longer than ${MAX_QUERY} characters`);
  const asked = Number(b.max_tokens ?? b.max_completion_tokens);
  const maxTokens = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 2048) : await getMaxTokens();
  const personality = getPersonality(await getPersonalityId());

  const handle = answer(
    { query: last.text },
    (e: AnswerEvent) => {
      if (e.type === "token" && chunk) chunk(e.text);
    },
    {
      systemPrompt: personality.systemPrompt,
      styleReminder: personality.styleReminder,
      history: { turns: turns.slice(0, -1).slice(-HISTORY_TURNS) },
      maxTokens,
    }
  );
  const result = await handle.done;
  const model = await modelName();
  return {
    id: `chatcmpl-${result.answerId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.outcome === "success" ? "stop" : result.outcome },
    ],
    boar_sources: await passages(result.sources),
  };
}

async function run(req: ApiRequest, chunk?: (text: string) => void): Promise<unknown> {
  if (chatsLocked()) throw new Error("BOAR is locked: enter the PIN in the app.");
  if (req.kind === "models") return { object: "list", data: [{ id: await modelName(), object: "model", owned_by: "boar" }] };
  if (req.kind === "search") return search(req.body);
  return chat(req.body, chunk);
}

/** Listens for the server's requests (once the chat, and so the models, are up). Returns the unsubscribe. */
export function startApiServer(): (() => void) | undefined {
  const mod = apiServer;
  if (!mod) return undefined;
  const off = mod.onRequest((raw) => {
    const req = raw as ApiRequest;
    const chunk = req.stream ? (text: string) => void mod.chunk(req.id, text) : undefined;
    run(req, chunk).then(
      (result) => mod.reply(req.id, { ok: true, result }),
      (e) => mod.reply(req.id, { ok: false, error: e instanceof Error ? e.message : String(e) })
    );
  });
  void mod.ready();
  return off;
}
