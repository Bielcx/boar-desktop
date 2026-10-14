/**
 * The document picker with copyToCacheDirectory copies each picked file into
 * the app's cache (a full copy of a private document). Only those copies may
 * be deleted after an import: never the user's original (content://) or
 * anything outside the cache.
 */
export function pickerCopiesToDelete(uris: readonly string[], cacheDirectory: string | null): string[] {
  if (!cacheDirectory) return [];
  const root = cacheDirectory.endsWith("/") ? cacheDirectory : `${cacheDirectory}/`;
  return [...new Set(uris)].filter(
    (uri) => uri.startsWith("file://") && uri.startsWith(root) && !uri.slice(root.length).split("/").includes("..")
  );
}
