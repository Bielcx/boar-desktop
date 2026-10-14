// The "ApiServer" native module on desktop (src/services/apiServer.ts finds it through the expo-modules-core shim;
// Android's Expo app has none): the local HTTP API's settings and tokens live in main (handlers/api-server.ts), which
// hands each authorized request to the page and gets the answer back here.
import { native } from "../shared/bridge";

const call = <T>(method: string, ...args: unknown[]) => native().invoke<T>(`api-server:${method}`, ...args);

export const ApiServer = {
  get: () => call("get"),
  set: (config: { enabled: boolean; port: number }) => call("set", config),
  /** The token in full, returned this once. `days`: null never expires. */
  createToken: (name: string, days: number | null) => call("createToken", name, days),
  revokeToken: (id: string) => call("revokeToken", id),
  ready: () => call<void>("ready"),
  chunk: (id: string, text: string) => call<void>("chunk", id, text),
  reply: (id: string, reply: { ok: boolean; result?: unknown; error?: string }) => call<void>("reply", id, reply),
  onRequest: (listener: (req: unknown) => void) => native().on("api-server:request", listener),
};
