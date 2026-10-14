// Desktop shim for "file-hash". See shared/bridge.ts.
// Hashing and copying run in main (desktop/src/main/handlers/file-hash.ts), streamed, never loading the whole file.
import { native } from "../shared/bridge";

export interface FileHashProgressEvent {
  jobId: string;
  bytesHashed: number;
  totalBytes: number;
}

/** Electron IPC keeps only an error's message; put the module's E_CANCELLED code back where fileHash.ts looks for it. */
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  try {
    return await native().invoke<T>(`file-hash:${method}`, ...args);
  } catch (e: any) {
    if (String(e?.message).includes("E_CANCELLED")) e.code = "E_CANCELLED";
    throw e;
  }
}

export const FileHashNative = {
  sha256: (uri: string, jobId: string) => call<string>("sha256", uri, jobId),
  copyWithSha256: (srcUri: string, destUri: string, jobId: string) =>
    call<{ sha256: string; bytes: number }>("copyWithSha256", srcUri, destUri, jobId),
  size: (uri: string) => call<number>("size", uri).catch(() => -1),
  cancel: (jobId: string) => void call("cancel", jobId).catch(() => {}),
  addListener(_event: "onProgress", listener: (event: FileHashProgressEvent) => void) {
    const off = native().on("file-hash:onProgress", (e) => listener(e as FileHashProgressEvent));
    return { remove: off };
  },
};
