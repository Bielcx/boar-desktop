import type { HandlerContext } from "./context";
import { register as llama_rn } from "./llama.rn";
import { register as expo_sqlite } from "./expo-sqlite";
import { register as expo_file_system } from "./expo-file-system";
import { register as expo_file_system_legacy } from "./expo-file-system-legacy";
import { register as ram_monitor } from "./ram-monitor";
import { register as file_hash } from "./file-hash";
import { register as offline_location } from "./offline-location";
import { register as download_wake_lock } from "./download-wake-lock";
import { register as device_key } from "./device-key";
import { register as bundled_assets } from "./bundled-assets";
import { register as voice_input } from "./voice-input";
import { register as expo_pdf_text_extract } from "./expo-pdf-text-extract";
import { register as expo_sharing } from "./expo-sharing";
import { register as expo_document_picker } from "./expo-document-picker";
import { register as speech_output } from "./speech-output";
import { register as library_share } from "./library-share";
import { register as folder_watch } from "./folder-watch";
import { register as pin_lock } from "./pin-lock";
import { register as api_server } from "./api-server";
import { register as expo_network } from "./expo-network";

/**
 * One register() per entry of shared/packages.json (module name -> shim / handler / channel prefix), which metro.config.js
 * and preload.ts also read; a desktop test checks this map against it.
 */
export const HANDLERS: Record<string, (ctx: HandlerContext) => void> = {
  "llama.rn": llama_rn,
  "expo-sqlite": expo_sqlite,
  "expo-file-system": expo_file_system,
  "expo-file-system-legacy": expo_file_system_legacy,
  "ram-monitor": ram_monitor,
  "file-hash": file_hash,
  "offline-location": offline_location,
  "download-wake-lock": download_wake_lock,
  "device-key": device_key,
  "bundled-assets": bundled_assets,
  "voice-input": voice_input,
  "expo-pdf-text-extract": expo_pdf_text_extract,
  "expo-sharing": expo_sharing,
  "expo-document-picker": expo_document_picker,
  "speech-output": speech_output,
  "library-share": library_share,
  "folder-watch": folder_watch,
  "pin-lock": pin_lock,
  "api-server": api_server,
  "expo-network": expo_network,
};

export function registerAll(ctx: HandlerContext): void {
  for (const register of Object.values(HANDLERS)) register(ctx);
}
