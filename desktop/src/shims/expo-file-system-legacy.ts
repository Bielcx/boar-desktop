// Desktop shim for "expo-file-system/legacy". See shared/bridge.ts.
// Every call goes to the main process (desktop/src/main/handlers/expo-file-system-legacy.ts), which only touches paths
// inside the app's data folder.
import { native } from "../shared/bridge";

const call = <T>(method: string, ...args: unknown[]) => native().invoke<T>(`expo-file-system-legacy:${method}`, ...args);

// The preload script sets window.boarNative before any app code runs, so these are known at import, like expo's.
export const documentDirectory: string | null = native().dirs.document;
export const cacheDirectory: string | null = native().dirs.cache;

export const EncodingType = { UTF8: "utf8", Base64: "base64" } as const;
export type EncodingType = (typeof EncodingType)[keyof typeof EncodingType];

export type FileInfo =
  | { exists: true; uri: string; size: number; isDirectory: boolean; modificationTime: number; md5?: string }
  | { exists: false; uri: string; isDirectory: false };

export const getInfoAsync = (uri: string, _opts?: { md5?: boolean }) => call<FileInfo>("getInfoAsync", uri);
export const readAsStringAsync = (uri: string, opts?: { encoding?: EncodingType }) =>
  call<string>("readAsStringAsync", uri, opts ? { encoding: opts.encoding } : undefined);
export const writeAsStringAsync = (uri: string, text: string, opts?: { encoding?: EncodingType }) =>
  call<void>("writeAsStringAsync", uri, text, opts ? { encoding: opts.encoding } : undefined);
export const deleteAsync = (uri: string, opts?: { idempotent?: boolean }) => call<void>("deleteAsync", uri, opts);
export const makeDirectoryAsync = (uri: string, opts?: { intermediates?: boolean }) => call<void>("makeDirectoryAsync", uri, opts);
export const readDirectoryAsync = (uri: string) => call<string[]>("readDirectoryAsync", uri);
export const moveAsync = (o: { from: string; to: string }) => call<void>("moveAsync", { from: o.from, to: o.to });
export const copyAsync = (o: { from: string; to: string }) => call<void>("copyAsync", { from: o.from, to: o.to });
export const getFreeDiskStorageAsync = () => call<number>("getFreeDiskStorageAsync");

export interface DownloadProgressData {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}
export interface FileSystemDownloadResult {
  uri: string;
  status: number;
  headers: Record<string, string>;
  mimeType: string | null;
}
export interface DownloadOptions {
  headers?: Record<string, string>;
}
export interface DownloadPauseState {
  url: string;
  fileUri: string;
  options: DownloadOptions;
  resumeData?: string;
}

let nextId = 0;

/**
 * expo's DownloadResumable over IPC. downloadAsync/resumeAsync resolve with the result, or undefined when paused;
 * pauseAsync stops the transfer in main and records how many bytes are on disk as resumeData (a byte offset, as on
 * Android), which the next resumeAsync sends as a Range request.
 */
export class DownloadResumable {
  private id = `dl-${Date.now()}-${++nextId}`;

  constructor(
    private url: string,
    private _fileUri: string,
    private options: DownloadOptions = {},
    private callback?: (data: DownloadProgressData) => void,
    private resumeData?: string
  ) {}

  get fileUri(): string {
    return this._fileUri;
  }

  private async run(resumeFrom: string | undefined): Promise<FileSystemDownloadResult | undefined> {
    const off = this.callback
      ? native().on("expo-file-system-legacy:downloadProgress", (id, data) => {
          if (id === this.id) this.callback?.(data as DownloadProgressData);
        })
      : null;
    try {
      const r = await call<FileSystemDownloadResult | null>("downloadAsync", this.id, this.url, this._fileUri, this.options.headers ?? {}, resumeFrom);
      return r ?? undefined;
    } finally {
      off?.();
    }
  }

  downloadAsync(): Promise<FileSystemDownloadResult | undefined> {
    return this.run("0");
  }

  /** Continues from resumeData, or from the file's length when there is none. */
  resumeAsync(): Promise<FileSystemDownloadResult | undefined> {
    return this.run(this.resumeData);
  }

  async pauseAsync(): Promise<DownloadPauseState> {
    this.resumeData = await call<string>("pauseDownload", this.id, this._fileUri);
    return this.savable();
  }

  savable(): DownloadPauseState {
    return { url: this.url, fileUri: this._fileUri, options: this.options, resumeData: this.resumeData };
  }
}

export function createDownloadResumable(
  url: string,
  fileUri: string,
  options?: DownloadOptions,
  callback?: (data: DownloadProgressData) => void,
  resumeData?: string
): DownloadResumable {
  return new DownloadResumable(url, fileUri, options, callback, resumeData);
}
