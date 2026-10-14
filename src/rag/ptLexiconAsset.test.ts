import { describe, it, expect, vi } from "vitest";

describe("bundled Portuguese lexicon", () => {
  it("resolves and loads the real asset (fails if the require doesn't resolve or the file is empty)", async () => {
    vi.resetModules();
    const { ptLexicon, lexiconStatus } = await import("./ptLexiconAsset");
    const lex = ptLexicon();
    const status = lexiconStatus();
    expect(status.state).toBe("loaded");
    expect(status.state === "loaded" && status.names).toBeGreaterThan(100000);
    expect(lex["estacao do ano"]).toBe("Season");
  });

  it("reports a failure instead of passing silently, without throwing", async () => {
    vi.resetModules();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ptLexicon, lexiconStatus } = await import("./ptLexiconAsset");
    // The asset missing from the bundle: require throws.
    const lex = ptLexicon(() => {
      throw new Error("Cannot find module '../../assets/lexicon/pt-en.json'");
    });
    expect(lex).toEqual({});
    expect(lexiconStatus()).toMatchObject({ state: "failed", error: expect.stringMatching(/Cannot find module/) });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
