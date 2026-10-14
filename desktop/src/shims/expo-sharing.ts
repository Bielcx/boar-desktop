// Desktop shim for "expo-sharing": no share sheet on desktop, so "share" means "save a copy where I
// choose" (save dialog in handlers/expo-sharing.ts). Cancelling resolves, like dismissing the sheet.
import { native } from "../shared/bridge";

export interface SharingOptions {
  mimeType?: string;
  UTI?: string;
  dialogTitle?: string;
}

export const isAvailableAsync = async (): Promise<boolean> => true;
export async function shareAsync(url: string, options: SharingOptions = {}): Promise<void> {
  await native().invoke("expo-sharing:shareAsync", url, options);
}
