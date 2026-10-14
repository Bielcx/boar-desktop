// Desktop shim for "expo-document-picker": the system open dialog (handlers/expo-document-picker.ts).
// Picked files are always copied into the app's cache dir, so the expo-file-system shim can read them.
import type { DocumentPickerOptions, DocumentPickerResult } from "expo-document-picker";
import { native } from "../shared/bridge";

export type { DocumentPickerAsset, DocumentPickerOptions, DocumentPickerResult } from "expo-document-picker";

export function getDocumentAsync(options: DocumentPickerOptions = {}): Promise<DocumentPickerResult> {
  const type = options.type === undefined ? [] : ([] as string[]).concat(options.type);
  return native().invoke<DocumentPickerResult>("expo-document-picker:getDocumentAsync", {
    type,
    multiple: options.multiple ?? false,
  });
}
