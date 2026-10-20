import { execFile } from "node:child_process";
import type { HandlerContext } from "./context";

/**
 * Whether Windows itself says there's internet: the connection profiles whose IPv4 or IPv6 connectivity is "Internet",
 * what the taskbar's "No internet" reads (NCSI). navigator.onLine stays true while any adapter is up, and WSL's
 * Hyper-V or VirtualBox's host-only adapter always is: with the Wi-Fi off, the header still said ONLINE. Asks the OS
 * only; nothing goes over the network.
 */
const QUERY =
  "@(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -eq 'Internet' -or $_.IPv6Connectivity -eq 'Internet' }).Count";

/** PowerShell's printed count -> reachable; null when it printed something else (the caller falls back). */
export function internetFromCount(stdout: string): boolean | null {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n > 0 : null;
}

let inFlight: Promise<boolean | null> | null = null;

/** null off Windows or when PowerShell fails: the shim uses navigator.onLine then. */
export function internetReachable(): Promise<boolean | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return (inFlight ??= new Promise<boolean | null>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", QUERY], { timeout: 8000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : internetFromCount(stdout))
    );
  }).finally(() => (inFlight = null)));
}

export function register(ctx: HandlerContext): void {
  ctx.ipcMain.handle("expo-network:internet", () => internetReachable());
}
