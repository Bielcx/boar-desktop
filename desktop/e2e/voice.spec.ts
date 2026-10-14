/**
 * Voice input end to end, with Chromium's fake microphone playing test/fixtures/voice-en.wav (Windows TTS, then a
 * pause): tap the mic, the app records through getUserMedia, stops by itself after the pause, whisper transcribes in
 * main, and the text lands in the chat input. Needs the whisper model (ggml-base-q5_1.bin) in BOAR_TEST_MODELS_DIR.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { chatInput, completeSetup, DESKTOP, launch, MODELS_DIR, modelsMissing, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

const WHISPER = MODELS_DIR ? path.join(MODELS_DIR, "ggml-base-q5_1.bin") : "";
test.skip(modelsMissing || !fs.existsSync(WHISPER), `${SKIP_REASON} and ggml-base-q5_1.bin`);

test("mic -> whisper -> chat input", async () => {
  const userData = tempUserData();
  const wav = path.join(DESKTOP, "test/fixtures/voice-en.wav");
  const s = await launch(userData, ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`]);
  try {
    await completeSetup(s.page, userData);
    fs.linkSync(WHISPER, path.join(userData, "documents/models/whisper-ggml-base-q5_1.bin"));
    await s.page.getByText("🎤").click();
    await expect(chatInput(s.page)).toHaveValue(/drinking water/i, { timeout: 90_000 });
    expect(s.dialogs).toEqual([]);
    expect(s.errors).toEqual([]);
  } finally {
    await s.app.close();
    rmUserData(userData);
  }
});
