import * as FileSystem from "expo-file-system/legacy";
import { pickerCopiesToDelete } from "./pickerCache.pure";

/** Deletes the cache copies the document picker made for `files`, once they are imported (or the import failed). */
export async function discardPickerCopies(files: readonly { uri: string }[]): Promise<void> {
  const copies = pickerCopiesToDelete(
    files.map((f) => f.uri),
    FileSystem.cacheDirectory
  );
  await Promise.all(copies.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})));
}
