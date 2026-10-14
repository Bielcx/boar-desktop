import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** True if `p` is `root` or somewhere under it. Case-insensitive on Windows (path.relative is). Text only, no disk access. */
export function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/**
 * file:// URI -> absolute local path, without touching the disk. Refuses anything that isn't file://, and network or
 * device paths: file://host/share/x is \\host\share\x on Windows, and merely stat-ing it opens an SMB connection
 * that hands the user's NTLM hash to that host.
 */
export function localPathOf(uri: unknown): string {
  if (typeof uri !== "string" || !uri.startsWith("file://")) throw new Error(`not a file:// URI: ${String(uri)}`);
  let p: string;
  try {
    p = fileURLToPath(uri);
  } catch {
    throw new Error(`bad file URI: ${uri}`);
  }
  if (/^[\\/]{2}/.test(p)) throw new Error(`network or device path refused: ${uri}`);
  return resolve(p);
}

/**
 * The one door from a renderer URI to a disk path. Every path the renderer sends is a file:// URI; it must land inside
 * one of `roots` (the app's documents and cache folders, not the rest of userData, which holds Chromium's profile)
 * after resolving "..", checked as text before any disk access, and again after following symlinks of the part that
 * already exists (so a link inside a root pointing outside doesn't count as inside). Anything else throws.
 */
export function safePath(roots: readonly string[], uri: unknown): string {
  const p = localPathOf(uri);
  const root = roots.map((r) => resolve(r)).find((r) => inside(r, p));
  if (root === undefined) throw new Error(`path outside the app's data folder: ${uri}`);
  let existing = p;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (!inside(realpathSync.native(root), realpathSync.native(existing))) {
    throw new Error(`path outside the app's data folder: ${uri}`);
  }
  return p;
}
