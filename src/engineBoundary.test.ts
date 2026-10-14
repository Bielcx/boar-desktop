import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One engine, two UIs (docs/PLATFORM_UIS.md): the engine is shared by the iOS and the Android UI,
 * so nothing in it may import from a UI folder (src/ui, src/ui-ios, src/ui-android).
 */
const ENGINE = ["rag", "routing", "inference", "models", "services", "eval", "config", "voice", "constants", "location", "i18n"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("engine boundary", () => {
  it("no engine file imports from a UI folder", () => {
    const offenders: string[] = [];
    for (const d of ENGINE) {
      let list: string[] = [];
      try {
        list = files(join(__dirname, d));
      } catch {
        continue;
      }
      for (const f of list) {
        const src = readFileSync(f, "utf8");
        if (/from\s+["'](?:\.\.\/)+ui(?:-ios|-android)?\//.test(src)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
