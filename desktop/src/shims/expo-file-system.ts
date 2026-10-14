// Desktop shim for "expo-file-system". See shared/bridge.ts.
// The app uses only `File`, in src/models/fileHash.ts's JS hashing fallback, which runs only when the file-hash native
// module is missing. On desktop the file-hash shim is always there, so the fallback never runs.
// ponytail: File's API is synchronous (file.size, handle.readBytes()) and IPC is not; implement it over sendSync only if
// something on desktop ever needs it.
export class File {
  constructor(uri: string) {
    throw new Error(`expo-file-system's File isn't available on desktop (${uri}); use the file-hash module`);
  }
}
