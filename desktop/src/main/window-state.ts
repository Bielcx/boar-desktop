/**
 * The window comes back where it was: size, position and maximized, saved to <userData>/window-state.json on close.
 * A saved position is dropped when no screen shows the window's top any more (a monitor unplugged since).
 */
import { readFileSync, writeFileSync } from "node:fs";

export type Rect = { x: number; y: number; width: number; height: number };
export type WindowState = Rect & { maximized: boolean };

const MIN = { width: 420, height: 600 }; // BrowserWindow's minWidth/minHeight in main.ts

export function restorable(saved: unknown, workAreas: Rect[]): WindowState | undefined {
  const s = saved as Partial<WindowState> | null;
  if (!s || ![s.x, s.y, s.width, s.height].every((n) => Number.isFinite(n))) return undefined;
  const st: WindowState = {
    x: s.x!,
    y: s.y!,
    width: Math.max(MIN.width, s.width!),
    height: Math.max(MIN.height, s.height!),
    maximized: s.maximized === true,
  };
  // The title bar (top 40 px, at least 100 px of it) has to be on some screen, or the window can't be dragged back.
  const onScreen = workAreas.some(
    (a) =>
      Math.min(st.x + st.width, a.x + a.width) - Math.max(st.x, a.x) >= 100 &&
      st.y >= a.y &&
      st.y + 40 <= a.y + a.height
  );
  return onScreen ? st : undefined;
}

export function loadWindowState(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // first run or a broken file: default size, centred
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {
    // ponytail: losing the window position is harmless; never block quitting over it.
  }
}
