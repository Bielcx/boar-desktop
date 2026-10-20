import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { HandlerContext } from "./context";

/**
 * "SpeechOutput" (src/voice/speech.ts): reads text aloud with the operating system's own voices, offline.
 * Electron's speechSynthesis lists no voices on Windows, so main drives System.Speech (SAPI) instead, which
 * ships Microsoft Maria (pt-BR) and Zira/David (en-US). The text goes in on stdin, never on the command line.
 *
 * On Linux, speech-dispatcher (`spd-say`, installed with Ubuntu's and Fedora's desktops for the screen reader) with
 * its default voice, usually espeak-ng. Off when it isn't installed.
 *
 * ponytail: one process per answer (~0.5 s to start speaking); a long-lived process or an embedded Piper voice if
 * that latency matters. macOS `say` would plug in the same way.
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

/** Whether an executable is on PATH (no shell, no `which`). */
function onPath(name: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The command that reads stdin aloud in `lang` ("pt" / "en"), or null on a system without one. */
export function speaker(platform: NodeJS.Platform, lang: string, has: (name: string) => boolean = onPath): [string, string[]] | null {
  if (platform === "win32") return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script(lang)]];
  // -e: the text from stdin; -w: return when it has been read, so the app stops showing "speaking".
  if (platform === "linux" && has("spd-say")) return ["spd-say", ["-w", "-e", "-l", lang]];
  return null;
}

export function register(ctx: HandlerContext): void {
  let current: ChildProcess | null = null;
  const stop = () => {
    current?.kill();
    current = null;
    // The speech-dispatcher server keeps reading after its client is killed: cancel it too.
    if (process.platform === "linux") spawn("spd-say", ["-C"], { stdio: "ignore" }).on("error", () => {});
  };

  ctx.ipcMain.handle("speech-output:available", () => speaker(process.platform, "en") !== null);

  ctx.ipcMain.handle("speech-output:speak", (_e, text: unknown, lang: unknown) => {
    if (typeof text !== "string" || !text.trim()) return;
    const code = typeof lang === "string" && lang.toLowerCase().startsWith("pt") ? "pt" : "en";
    if (!LANG.test(code)) return;
    const cmd = speaker(process.platform, code);
    if (!cmd) throw new Error("Reading aloud isn't available on this system yet");
    if (current) stop();
    const child = spawn(cmd[0], cmd[1], {
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
