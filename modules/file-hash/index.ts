import { requireOptionalNativeModule, EventSubscription } from "expo-modules-core";

export interface FileHashProgressEvent {
  jobId: string;
  bytesHashed: number;
  totalBytes: number;
}

export interface FileHashNativeModule {
  /** Lowercase hex SHA-256 of a file:// or content:// URI, read in chunks. */
  sha256(uri: string, jobId: string): Promise<string>;
  /**
   * Copies srcUri (file:// or content://) to destUri (file://) and returns the
   * SHA-256 of the bytes written, in one pass over the source.
   */
  copyWithSha256(srcUri: string, destUri: string, jobId: string): Promise<{ sha256: string; bytes: number }>;
  /** Size in bytes of a file:// or content:// URI (a Long on the native side, so files over 2 GB are right), -1 if unknown. */
  size?(uri: string): Promise<number>;
  /** Stops a running job at the next chunk; it rejects with code E_CANCELLED (a partial copy is deleted). */
  cancel?(jobId: string): void;
  addListener(eventName: "onProgress", listener: (event: FileHashProgressEvent) => void): EventSubscription;
}

// Optional: iOS and older builds without this module fall back to the JS
// implementation in src/models/fileHash.ts.
export const FileHashNative = requireOptionalNativeModule<FileHashNativeModule>("FileHash");
