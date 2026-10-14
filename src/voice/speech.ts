/**
 * Reading answers aloud (text-to-speech), fully offline.
 *
 * A native "SpeechOutput" module when the platform has one: on desktop it drives the operating system's
 * voices from main (desktop/src/main/handlers/speech-output.ts; Windows ships Maria pt-BR). Otherwise the
 * browser's speechSynthesis. Android has neither yet: the system TextToSpeech, or an embedded Piper voice
 * on de-Googled phones, would be a SpeechOutput module with this same API. Until then speechAvailable() is
 * false there and the setting is hidden.
 */
import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

interface SpeechOutputModule {
  /** Resolves when reading ends or is stopped. */
  speak(text: string, lang: string): Promise<void>;
  stop(): Promise<void>;
}

const nativeSpeech = requireOptionalNativeModule<SpeechOutputModule>("SpeechOutput");

type Listener = (speaking: boolean) => void;
const listeners = new Set<Listener>();
let speaking = false;
// Each speak() bumps it, so a reading that ends late doesn't clear the flag of the one that replaced it.
let turn = 0;

function setSpeaking(v: boolean): void {
  if (speaking === v) return;
  speaking = v;
  listeners.forEach((l) => l(v));
}

function webSynth(): SpeechSynthesis | null {
  if (Platform.OS !== "web") return null;
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function speechAvailable(): boolean {
  return nativeSpeech !== null || webSynth() !== null;
}

/** Called with true when reading starts and false when it ends or is stopped. Returns an unsubscribe. */
export function onSpeakingChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The answer as it should sound: no "[1]" source marks, no markdown symbols, no code blocks or links.
 * Pure, so it is unit-tested.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~#|]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
}

/** The best installed voice for the app language ("pt" → a pt-BR voice first), or the system default. */
function pickVoice(s: SpeechSynthesis, lang: string): SpeechSynthesisVoice | undefined {
  const voices = s.getVoices();
  const prefix = lang.toLowerCase().slice(0, 2);
  const preferred = prefix === "pt" ? "pt-br" : prefix === "en" ? "en-us" : "";
  return (
    voices.find((v) => v.lang.toLowerCase() === preferred) ?? voices.find((v) => v.lang.toLowerCase().startsWith(prefix))
  );
}

/** Reads the text aloud, replacing anything being read. No-op where speech isn't available. */
export function speak(text: string, lang: string): void {
  const clean = cleanForSpeech(text);
  if (!clean) return;
  const mine = ++turn;
  if (nativeSpeech) {
    setSpeaking(true);
    nativeSpeech
      .speak(clean, lang)
      .catch(() => {})
      .finally(() => mine === turn && setSpeaking(false));
    return;
  }
  const s = webSynth();
  if (!s) return;
  s.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice(s, lang);
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? (lang.startsWith("pt") ? "pt-BR" : "en-US");
  u.onstart = () => setSpeaking(true);
  u.onend = u.onerror = () => mine === turn && setSpeaking(false);
  s.speak(u);
}

export function stopSpeaking(): void {
  turn++;
  nativeSpeech?.stop().catch(() => {});
  webSynth()?.cancel();
  setSpeaking(false);
}
