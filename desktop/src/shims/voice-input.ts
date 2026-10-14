// Desktop voice input: the "VoiceInput" native module src/voice/VoiceInput.ts looks up, rebuilt on the web platform.
// Nothing imports the "voice-input" package; VoiceInput.ts calls requireOptionalNativeModule("VoiceInput"), which
// metro.config.js points at shims/expo-modules-core.ts for app code, and that returns this object.
//
// Same contract as modules/voice-input (Android): getRecognitionMode/isAvailable/startListening/stopListening and the
// events onSpeechStart, onSpeechEnd, onPartialResults, onResults, onError ({code, message}, Android's numeric codes).
// Audio: getUserMedia (main.ts allows the mic for the app's own page only) -> 16 kHz mono PCM in the renderer ->
// whisper.cpp in main (handlers/voice-input.ts). It stops by itself after a pause, like Android's recognizer.
// The whisper model is fetched on first use, after the user agrees (see WHISPER_MODEL).
import i18n from "i18next";
import { native } from "../shared/bridge";
import { createDownloadResumable, deleteAsync, documentDirectory, getInfoAsync, makeDirectoryAsync, moveAsync } from "./expo-file-system-legacy";
import { FileHashNative } from "./file-hash";
import { networkAllowed } from "../../../src/config/variant";

/** whisper.cpp "base" multilingual, 5-bit (MIT), from the official ggerganov/whisper.cpp repo. */
export const WHISPER_MODEL = {
  filename: "models/whisper-ggml-base-q5_1.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
  sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  sizeBytes: 59707625,
};

const RATE = 16000;
const MAX_SECONDS = 30; // whisper's window (handlers/voice-input.ts MAX_PCM_BYTES)
// Calibration knobs: RMS of a float sample block. Room noise after the browser's noise suppression sits well below.
const SPEECH_RMS = 0.015;
const END_SILENCE_MS = 1200;
const NO_SPEECH_MS = 8000;
const PARTIAL_EVERY_MS = 1500;

type Listener = (event: any) => void;
const listeners = new Map<string, Set<Listener>>();
function emit(name: string, payload: object = {}) {
  for (const l of listeners.get(name) ?? []) l(payload);
}

const modelUri = () => documentDirectory + WHISPER_MODEL.filename;
const lang = (): "pt" | "en" => (i18n.language?.startsWith("pt") ? "pt" : "en");
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

async function modelReady(): Promise<boolean> {
  const info = await getInfoAsync(modelUri());
  return info.exists && info.size === WHISPER_MODEL.sizeBytes;
}

const MB = Math.round(WHISPER_MODEL.sizeBytes / 1e6);
const text = {
  en: {
    ask: `Voice input runs on this computer with a speech model (whisper, ${MB} MB) that isn't installed yet.\n\nDownload it now from Hugging Face? After that, voice works offline.`,
    ready: "Voice model installed. Tap the microphone again to speak.",
    offline: `Voice model missing: put ${WHISPER_MODEL.filename.split("/")[1]} in the app's models folder.`,
  },
  pt: {
    ask: `A voz roda neste computador com um modelo de fala (whisper, ${MB} MB) que ainda não está instalado.\n\nBaixar agora do Hugging Face? Depois disso a voz funciona offline.`,
    ready: "Modelo de voz instalado. Toque no microfone de novo para falar.",
    offline: `Falta o modelo de voz: coloque ${WHISPER_MODEL.filename.split("/")[1]} na pasta de modelos do app.`,
  },
};

/** First use: ask, download, check the sha256. Always throws (the session ends; the next tap records). */
async function installModel(): Promise<never> {
  const t = text[lang()];
  if (!networkAllowed()) throw fail("E_MODEL_MISSING", t.offline);
  if (!window.confirm(t.ask)) throw fail("E_MODEL_DECLINED", "Voice model download declined");
  const part = modelUri() + ".part";
  await makeDirectoryAsync(documentDirectory + "models", { intermediates: true }).catch(() => {});
  const r = await createDownloadResumable(WHISPER_MODEL.url, part).downloadAsync();
  if (!r || r.status < 200 || r.status >= 300) throw fail("E_MODEL_DOWNLOAD", `Voice model download failed (HTTP ${r?.status})`);
  const sha = await FileHashNative.sha256(part, `whisper-${Date.now()}`);
  if (sha !== WHISPER_MODEL.sha256) {
    await deleteAsync(part, { idempotent: true });
    throw fail("E_MODEL_CHECKSUM", "Voice model failed its integrity check");
  }
  await moveAsync({ from: part, to: modelUri() });
  window.alert(t.ready);
  throw fail("E_MODEL_INSTALLED", t.ready);
}

/** Float [-1, 1] at `from` Hz -> 16 kHz s16le bytes. Linear interpolation is enough for speech. */
export function toPcm16(chunks: Float32Array[], from: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const n = Math.min(Math.floor((total * RATE) / from), MAX_SECONDS * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * from) / RATE;
    const j = Math.floor(x);
    const s = (all[j] ?? 0) + ((all[j + 1] ?? all[j] ?? 0) - (all[j] ?? 0)) * (x - j);
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

interface Recording {
  stream: MediaStream;
  audio: AudioContext;
  chunks: Float32Array[];
  heard: boolean;
  startedAt: number;
  lastVoiceAt: number;
  timer: ReturnType<typeof setInterval>;
  partial: Promise<unknown> | null;
  done: boolean;
}

let rec: Recording | null = null;

const transcribe = (r: Recording) =>
  native().invoke<string>("voice-input:transcribe", modelUri(), toPcm16(r.chunks, r.audio.sampleRate), lang());

function release(r: Recording) {
  r.done = true;
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  void r.audio.close().catch(() => {});
  if (rec === r) rec = null;
}

/** Ends `r` and delivers the final text (onResults) or why there is none (onError). */
async function finish(r: Recording) {
  if (r.done) return;
  release(r);
  emit("onSpeechEnd");
  await r.partial?.catch(() => {});
  try {
    const text = await transcribe(r);
    if (text) emit("onResults", { text });
    else emit("onError", { code: "7", message: "No speech match" });
  } catch (e: any) {
    emit("onError", { code: "5", message: String(e?.message ?? e) });
  }
}

export const VoiceInput = {
  async isAvailable(): Promise<boolean> {
    return await native().invoke<boolean>("voice-input:isAvailable").catch(() => false);
  },

  /** Whisper runs on this machine: "on-device", whether or not its model is downloaded yet (first use asks). */
  async getRecognitionMode(): Promise<"on-device" | "unavailable"> {
    return (await VoiceInput.isAvailable()) ? "on-device" : "unavailable";
  },

  async startListening(_requireOnDevice: boolean): Promise<void> {
    if (rec) release(rec); // a new session drops the old one, as on Android
    if (!(await modelReady())) await installModel();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e: any) {
      throw fail("E_PERMISSION_DENIED", `Microphone unavailable: ${e?.message ?? e}`);
    }
    const audio = new AudioContext({ sampleRate: RATE });
    const source = audio.createMediaStreamSource(stream);
    // ponytail: ScriptProcessorNode is deprecated but needs no worklet module (the CSP has no blob:); AudioWorklet
    // served from app:// is the upgrade if Chromium drops it.
    const node = audio.createScriptProcessor(4096, 1, 1);
    const now = Date.now();
    const r: Recording = { stream, audio, chunks: [], heard: false, startedAt: now, lastVoiceAt: now, timer: 0 as any, partial: null, done: false };
    rec = r;
    node.onaudioprocess = (e) => {
      if (r.done) return;
      const block = new Float32Array(e.inputBuffer.getChannelData(0));
      r.chunks.push(block);
      const t = Date.now();
      const rms = Math.sqrt(block.reduce((s, x) => s + x * x, 0) / block.length);
      if (rms > SPEECH_RMS) {
        if (!r.heard) emit("onSpeechStart");
        r.heard = true;
        r.lastVoiceAt = t;
      }
      const seconds = r.chunks.reduce((n, c) => n + c.length, 0) / audio.sampleRate;
      if ((r.heard && t - r.lastVoiceAt > END_SILENCE_MS) || seconds >= MAX_SECONDS) void finish(r);
      else if (!r.heard && t - r.startedAt > NO_SPEECH_MS) {
        release(r);
        emit("onError", { code: "6", message: "No speech input" });
      }
    };
    source.connect(node);
    node.connect(audio.destination); // a ScriptProcessor only runs when connected; its output is silence
    r.timer = setInterval(() => {
      if (r.done || !r.heard || r.partial) return;
      r.partial = transcribe(r)
        .then((text) => !r.done && text && emit("onPartialResults", { text }))
        .catch(() => {})
        .finally(() => (r.partial = null));
    }, PARTIAL_EVERY_MS);
  },

  /** Like Android's: resolves at once; the text arrives as onResults. */
  async stopListening(): Promise<void> {
    if (rec) void finish(rec);
  },

  addListener(eventName: string, listener: Listener) {
    let set = listeners.get(eventName);
    if (!set) listeners.set(eventName, (set = new Set()));
    set.add(listener);
    return { remove: () => void set.delete(listener) };
  },
};
