/**
 * Desktop voice input: the main-side whisper handler through loopback IPC, on WAVs spoken by Windows' TTS
 * (test/fixtures/voice-{en,pt}.wav, 16 kHz mono, made with System.Speech; see desktop/docs/07-voz.md).
 * The transcription tests need the whisper model in BOAR_TEST_MODELS_DIR (ggml-base-q5_1.bin); skipped otherwise.
 *
 *   BOAR_TEST_MODELS_DIR=C:/Users/bielc/Dev/boar-shared-models npm test -- test/voice-input.test.ts   (in desktop/)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loopback } from "../src/testing/loopback";
import { cleanTranscript, register } from "../src/main/handlers/voice-input";
import type { BoarNative } from "../src/shared/bridge";

const MODELS = process.env.BOAR_TEST_MODELS_DIR ?? "";
const MODEL = path.join(MODELS, "ggml-base-q5_1.bin");
const haveModel = !!MODELS && fs.existsSync(MODEL);

/** The PCM samples of a 16 kHz mono 16-bit WAV (its "data" chunk). */
function pcmOf(file: string): Uint8Array {
  const b = fs.readFileSync(file);
  let o = 12;
  while (b.toString("ascii", o, o + 4) !== "data") o += 8 + b.readUInt32LE(o + 4);
  return new Uint8Array(b.subarray(o + 8, o + 8 + b.readUInt32LE(o + 4)));
}

let native: BoarNative;
let modelUri: string;

beforeAll(async () => {
  const data = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "boar-voice-"))), "data");
  const lb = loopback(data);
  register(lb.ctx);
  native = lb.native;
  (globalThis as any).window = { boarNative: native };
  fs.mkdirSync(path.join(data, "documents/models"), { recursive: true });
  // Hard link, never a copy of the model (same volume as the shared models folder).
  if (haveModel) fs.linkSync(MODEL, path.join(data, "documents/models/whisper-ggml-base-q5_1.bin"));
  modelUri = native.dirs.document + "models/whisper-ggml-base-q5_1.bin";
});

describe("voice-input", () => {
  it("drops whisper's non-speech tags", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript(" (music) Hello  there [Música]")).toBe("Hello there");
  });

  it("resamples float audio to 16 kHz s16le", async () => {
    const { toPcm16 } = await import("../src/shims/voice-input");
    const pcm = toPcm16([new Float32Array(48000).fill(0.5)], 48000); // 1 s at 48 kHz
    const s = new Int16Array(pcm.buffer);
    expect(s.length).toBe(16000);
    expect(s[100]).toBe(Math.trunc(0.5 * 0x7fff));
  });

  it("the binding loads", async () => {
    expect(await native.invoke("voice-input:isAvailable")).toBe(true);
  });

  it("refuses a model outside the app's folders and bad audio", async () => {
    await expect(native.invoke("voice-input:transcribe", "file:///C:/Windows/win.ini", new Uint8Array(4), "en")).rejects.toThrow(/outside/);
    await expect(native.invoke("voice-input:transcribe", modelUri, "not audio", "en")).rejects.toThrow(/bad audio/);
  });

  it.skipIf(!haveModel)("transcribes English", async () => {
    const text = await native.invoke<string>("voice-input:transcribe", modelUri, pcmOf(path.join(__dirname, "fixtures/voice-en.wav")), "en");
    expect(text).toMatch(/drinking water/i);
  }, 120_000);

  it.skipIf(!haveModel)("transcribes Portuguese", async () => {
    const text = await native.invoke<string>("voice-input:transcribe", modelUri, pcmOf(path.join(__dirname, "fixtures/voice-pt.wav")), "pt");
    expect(text).toMatch(/purifico/i);
    expect(text).toMatch(/água/i);
  }, 120_000);
});
