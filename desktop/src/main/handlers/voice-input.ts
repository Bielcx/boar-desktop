import type { WhisperContext } from "@fugood/whisper.node";
import { fileRoots, type HandlerContext } from "./context";
import { safePath } from "../storage/safePath";

/**
 * Main side of the desktop voice input (shims/voice-input.ts): whisper.cpp through @fugood/whisper.node, CPU build
 * only (the GPU belongs to the LLM). The renderer records and sends 16 kHz mono 16-bit PCM; nothing leaves the machine.
 */

/** 30 s of 16 kHz 16-bit audio: whisper's window, and what the shim caps a recording at. */
export const MAX_PCM_BYTES = 30 * 16000 * 2;

let loaded: { file: string; ctx: Promise<WhisperContext> } | null = null;
// whisper.cpp runs one transcription per context at a time: partials and the final one queue here.
let queue: Promise<unknown> = Promise.resolve();

async function whisper() {
  return await import("@fugood/whisper.node");
}

function context(file: string): Promise<WhisperContext> {
  if (loaded?.file !== file) {
    const previous = loaded?.ctx;
    previous?.then((c) => c.release()).catch(() => {});
    loaded = { file, ctx: whisper().then((w) => w.initWhisper({ filePath: file, useGpu: false })) };
    loaded.ctx.catch(() => (loaded = null));
  }
  return loaded.ctx;
}

/** Whisper's non-speech tags ("[BLANK_AUDIO]", "(music)", "[Música]") aren't words the user said. */
export function cleanTranscript(text: string): string {
  // ponytail: drops every bracketed/parenthesized span; whisper doesn't put real speech in them.
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/** Transcribes `pcm` (16 kHz mono s16le) with the ggml model at `file` (an absolute path already checked). */
export function transcribe(file: string, pcm: Uint8Array, language: "en" | "pt"): Promise<string> {
  const run = queue.then(async () => {
    const c = await context(file);
    const data = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    const { result } = await c.transcribeData(data, { language, temperature: 0 }).promise;
    return cleanTranscript(result);
  });
  queue = run.catch(() => {});
  return run;
}

export function register(ctx: HandlerContext): void {
  ctx.ipcMain.handle("voice-input:isAvailable", async () => {
    try {
      await (await whisper()).loadWhisperModule();
      return true;
    } catch {
      return false;
    }
  });
  ctx.ipcMain.handle("voice-input:transcribe", (_e, modelUri: unknown, pcm: unknown, language: unknown) => {
    const file = safePath(fileRoots(ctx), modelUri);
    if (!(pcm instanceof Uint8Array) || pcm.byteLength % 2 || pcm.byteLength > MAX_PCM_BYTES) throw new Error("voice-input: bad audio");
    return transcribe(file, pcm, language === "pt" ? "pt" : "en");
  });
}
