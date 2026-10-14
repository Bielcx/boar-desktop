// "expo-modules-core" as the app's own code (src/) sees it on desktop: the real package, except that
// requireOptionalNativeModule also finds the desktop native modules below. metro.config.js maps the import here only
// for files under src/; this file's own import (and every library's) gets the real package.
//
// Why not register in globalThis.expo.modules before the app loads: on web, expo's requireOptionalNativeModule only
// reads that registry inside a DOM-component webview (globalThis.ExpoDomWebView), and setting that flag would switch
// other packages (expo-sqlite, expo/dom) to their webview code paths.
import { requireOptionalNativeModule as expoRequireOptional } from "expo-modules-core";
import { VoiceInput } from "./voice-input";
import { SpeechOutput } from "./speech-output";
import { LibraryShare } from "./library-share";
import { FolderWatch } from "./folder-watch";
import { PinLock } from "./pin-lock";
import { ApiServer } from "./api-server";

export * from "expo-modules-core";

const DESKTOP_MODULES: Record<string, unknown> = { VoiceInput, SpeechOutput, LibraryShare, FolderWatch, PinLock, ApiServer };

export function requireOptionalNativeModule<ModuleType = any>(moduleName: string): ModuleType | null {
  return (DESKTOP_MODULES[moduleName] as ModuleType | undefined) ?? expoRequireOptional<ModuleType>(moduleName);
}
