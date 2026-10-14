import { onPageGone, type HandlerContext } from "./context";
import * as engine from "../llama/engine";

/**
 * Main-side handlers for the "llama.rn" shim. Logic lives in ../llama/engine.ts; this only wires channels.
 * Model paths must sit inside the documents folder or BOAR_MODELS_DIR (an explicit extra models folder).
 * Events: "llama.rn:progress" (progressId, pct 0-100), "llama.rn:token" (requestId, { token }).
 * A page that reloads or closes can't reach its contexts any more, so they're all released then (models take GBs).
 */
export function register(ctx: HandlerContext): void {
  const roots = () => [ctx.roots.document, process.env.BOAR_MODELS_DIR];
  const h = ctx.ipcMain;

  const releaseAll = () => void engine.releaseAll().catch((e) => console.warn("[llama] release on page exit:", e?.message ?? e));
  h.handle("llama.rn:initLlama", (event, params: engine.InitParams, progressId?: string) => {
    onPageGone(event?.sender, releaseAll);
    return engine.initContext(params, roots(), progressId ? (pct) => ctx.send("llama.rn:progress", progressId, pct) : undefined);
  });
  h.handle("llama.rn:completion", (_e, id: number, requestId: string, params: engine.CompletionParams) =>
    engine.completion(id, params, (data) => ctx.send("llama.rn:token", requestId, data))
  );
  h.handle("llama.rn:stopCompletion", (_e, id: number) => engine.stopCompletion(id));
  h.handle("llama.rn:tokenize", (_e, id: number, text: string) => engine.tokenize(id, text));
  h.handle("llama.rn:detokenize", (_e, id: number, tokens: number[]) => engine.detokenize(id, tokens));
  h.handle("llama.rn:embedding", (_e, id: number, text: string, params?: { embd_normalize?: number }) =>
    engine.embedding(id, text, params)
  );
  h.handle("llama.rn:release", (_e, id: number) => engine.release(id));
  h.handle("llama.rn:releaseAll", () => engine.releaseAll());
  h.handle("llama.rn:loadLlamaModelInfo", (_e, model: string) => engine.loadModelInfo(model, roots()));
  h.handle("llama.rn:getBackendDevicesInfo", () => engine.backendDevices());
}
