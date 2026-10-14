import { describe, expect, it } from "vitest";
import { restorable } from "../src/main/window-state";

const screen = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1280, height: 1024 };

describe("restorable window state", () => {
  it("keeps bounds that are on a screen", () => {
    expect(restorable({ x: 100, y: 50, width: 1300, height: 900, maximized: true }, [screen])).toEqual({
      x: 100, y: 50, width: 1300, height: 900, maximized: true,
    });
    expect(restorable({ x: 2000, y: 10, width: 800, height: 700 }, [screen, second])?.x).toBe(2000);
  });
  it("drops a position on a monitor that is gone, or with the title bar off screen", () => {
    expect(restorable({ x: 2000, y: 10, width: 800, height: 700 }, [screen])).toBeUndefined();
    expect(restorable({ x: 100, y: -200, width: 800, height: 700 }, [screen])).toBeUndefined();
    expect(restorable({ x: 1880, y: 10, width: 800, height: 700 }, [screen])).toBeUndefined(); // only 40 px visible
  });
  it("rejects junk and enforces the minimum size", () => {
    expect(restorable(undefined, [screen])).toBeUndefined();
    expect(restorable({ x: "a", y: 0, width: 1, height: 1 }, [screen])).toBeUndefined();
    expect(restorable({ x: 0, y: 0, width: 10, height: 10 }, [screen])).toMatchObject({ width: 420, height: 600, maximized: false });
  });
});
