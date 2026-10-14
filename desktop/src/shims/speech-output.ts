// The "SpeechOutput" native module on desktop (src/voice/speech.ts finds it through the expo-modules-core shim):
// reading aloud runs in main with the system's voices (handlers/speech-output.ts).
import { native } from "../shared/bridge";

export const SpeechOutput = {
  /** Resolves when reading ends or is stopped. */
  speak: (text: string, lang: string) => native().invoke<void>("speech-output:speak", text, lang),
  stop: () => native().invoke<void>("speech-output:stop"),
  available: () => native().invoke<boolean>("speech-output:available"),
};
