import { spawn, type ChildProcess } from "node:child_process";
import type { HandlerContext } from "./context";

/**
 * "SpeechOutput" (src/voice/speech.ts): reads text aloud with the operating system's own voices, offline.
 * Electron's speechSynthesis lists no voices on Windows, so main drives System.Speech (SAPI) instead, which
 * ships Microsoft Maria (pt-BR) and Zira/David (en-US). The text goes in on stdin, never on the command line.
 *
 * ponytail: one PowerShell process per answer (~0.5 s to start speaking); a long-lived process or an embedded
 * Piper voice if that latency matters. Windows only for now: macOS `say` / Linux espeak would plug in here.
 */
const MAX_CHARS = 8000;
const LANG = /^[a-z]{2}(-[A-Z]{2})?$/;

function script(lang: string): string {
  return [
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like '${lang}*' } | Select-Object -First 1`,
    "if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }",
    "$s.Speak([Console]::In.ReadToEnd())",
  ].join("; ");
}

export function register(ctx: HandlerContext): void {
  let current: ChildProcess | null = null;
  const stop = () => {
    current?.kill();
    current = null;
  };

  ctx.ipcMain.handle("speech-output:available", () => process.platform === "win32");

  ctx.ipcMain.handle("speech-output:speak", (_e, text: unknown, lang: unknown) => {
    if (process.platform !== "win32") throw new Error("Reading aloud isn't available on this system yet");
    if (typeof text !== "string" || !text.trim()) return;
    const code = typeof lang === "string" && lang.toLowerCase().startsWith("pt") ? "pt" : "en";
    if (!LANG.test(code)) return;
    stop();
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script(code)], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    current = child;
    child.stdin?.end(text.slice(0, MAX_CHARS), "utf8");
    // Resolves when reading ends or is stopped, so the app knows when to stop showing "speaking".
    return new Promise<void>((resolve) => {
      child.on("exit", () => {
        if (current === child) current = null;
        resolve();
      });
      child.on("error", () => resolve());
    });
  });

  ctx.ipcMain.handle("speech-output:stop", () => stop());
}
