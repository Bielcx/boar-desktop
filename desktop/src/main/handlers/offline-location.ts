import type { HandlerContext } from "./context";

// "offline-location": nothing on the main side, the shim answers "unavailable" by itself.
export function register(_ctx: HandlerContext): void {}
