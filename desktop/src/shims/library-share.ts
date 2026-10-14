// The "LibraryShare" native module on desktop (src/ui-android/LibraryShareSettings.tsx finds it through the
// expo-modules-core shim; Android has none, so the section isn't shown there): the MCP server's settings, kept by main
// (handlers/library-share.ts).
import { native } from "../shared/bridge";

export interface LibraryShareConfig {
  enabled: boolean;
  collections: string[];
  builtin: boolean;
}

export const LibraryShare = {
  get: () => native().invoke<LibraryShareConfig>("library-share:get"),
  set: (config: LibraryShareConfig) => native().invoke<LibraryShareConfig>("library-share:set", config),
  /** The claude_desktop_config.json snippet that starts this app's MCP server. */
  clientConfig: () => native().invoke<string>("library-share:clientConfig"),
};
