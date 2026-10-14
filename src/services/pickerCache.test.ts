import { describe, it, expect } from "vitest";
import { pickerCopiesToDelete } from "./pickerCache.pure";

const CACHE = "file:///data/user/0/com.boar/cache/";

describe("pickerCopiesToDelete", () => {
  it("deletes only the picker's copies inside the app cache", () => {
    const uris = [
      `${CACHE}DocumentPicker/abc/notes.pdf`,
      "content://com.android.providers.downloads.documents/document/42",
      "file:///data/user/0/com.boar/files/models/qwen.gguf",
      `${CACHE}DocumentPicker/abc/notes.pdf`,
    ];
    expect(pickerCopiesToDelete(uris, CACHE)).toEqual([`${CACHE}DocumentPicker/abc/notes.pdf`]);
  });

  it("accepts a cache directory without a trailing slash but not a sibling prefix", () => {
    const dir = CACHE.slice(0, -1);
    expect(pickerCopiesToDelete([`${CACHE}a.txt`, `${dir}-other/a.txt`], dir)).toEqual([`${CACHE}a.txt`]);
  });

  it("refuses paths that climb out of the cache", () => {
    expect(pickerCopiesToDelete([`${CACHE}DocumentPicker/../../files/chat.db`], CACHE)).toEqual([]);
  });

  it("does nothing without a cache directory", () => {
    expect(pickerCopiesToDelete([`${CACHE}a.txt`], null)).toEqual([]);
  });
});
