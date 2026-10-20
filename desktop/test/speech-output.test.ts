import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
import { speaker } from "../src/main/handlers/speech-output";

describe("speech-output: the system's reader", () => {
  it("uses SAPI on Windows and speech-dispatcher on Linux, when installed", () => {
    expect(speaker("win32", "pt")?.[0]).toBe("powershell.exe");
    expect(speaker("linux", "pt", () => true)).toEqual(["spd-say", ["-w", "-e", "-l", "pt"]]);
    expect(speaker("linux", "en", () => false)).toBeNull();
    expect(speaker("darwin", "en", () => true)).toBeNull();
  });
});
