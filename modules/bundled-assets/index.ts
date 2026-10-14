import { requireNativeModule } from "expo-modules-core";

interface BundledAssetsNativeModule {
  list(subdir: string): Promise<string[]>;
  copyToFile(assetPath: string, destAbsolutePath: string): Promise<number>;
  excludeFromBackup(path: string): Promise<boolean>;
}

const BundledAssets = requireNativeModule<BundledAssetsNativeModule>("BundledAssets");

/**
 * Lists files under android/app/src/main/assets/<subdir>/ inside the APK, or
 * under <subdir>/ in the iOS app bundle's resources.
 */
export function listBundledAssets(subdir: string): Promise<string[]> {
  return BundledAssets.list(subdir);
}

/**
 * Copies android/app/src/main/assets/<assetPath> to destAbsolutePath
 * (typically under FileSystem.documentDirectory), purely locally, no
 * network. Returns the copied file's size in bytes.
 */
export function copyBundledAssetToFile(assetPath: string, destAbsolutePath: string): Promise<number> {
  return BundledAssets.copyToFile(assetPath, destAbsolutePath);
}

/**
 * Excludes a file or directory (path or file:// URI) from iCloud/iTunes
 * backup. Call it on every multi-GB model or index written to the document
 * directory. iOS only; on Android it just reports whether the path exists.
 * Resolves false (never throws) if the path is missing or the native module
 * is older than this function.
 */
export async function excludeFromBackup(path: string): Promise<boolean> {
  try {
    return await BundledAssets.excludeFromBackup(path);
  } catch {
    return false;
  }
}
