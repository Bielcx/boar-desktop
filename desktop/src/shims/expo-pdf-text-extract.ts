// Desktop shim for "expo-pdf-text-extract". See shared/bridge.ts.
// Extraction runs in main (pdf.js in a worker thread, handlers/expo-pdf-text-extract.ts). Its errors start with the
// native module's code ("PASSWORD_REQUIRED: ..."); IPC keeps only the message, so put it back on `code` and drop the
// prefixes, as documentImporter.ts reads `code` and shows the message.
import { native } from "../shared/bridge";

export async function extractText(uri: string): Promise<string> {
  try {
    return await native().invoke<string>("expo-pdf-text-extract:extractText", uri);
  } catch (e: any) {
    const m = /^(?:Error invoking remote method '[^']*': )?(?:Error: )?([A-Z_]+): ([\s\S]*)$/.exec(String(e?.message));
    if (!m) throw e;
    throw Object.assign(new Error(m[2]), { code: m[1] });
  }
}
