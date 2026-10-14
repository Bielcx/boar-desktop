// Desktop shim for "bundled-assets": the desktop build ships no models inside the app (they're
// downloaded), so there is nothing to list or copy.
export const listBundledAssets = async (_subdir: string): Promise<string[]> => [];
export async function copyBundledAssetToFile(assetPath: string, _dest: string): Promise<number> {
  throw new Error(`no bundled assets on desktop: ${assetPath}`);
}
export const excludeFromBackup = async (_path: string): Promise<boolean> => false;
