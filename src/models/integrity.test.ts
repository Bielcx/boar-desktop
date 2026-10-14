import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetIntegrityError,
  ImportAbortedError,
  isAbortError,
  candidatesBySize,
  digestsEqual,
  errorKindOf,
  matchByDigest,
  sha256Chunked,
  type ChunkReader,
} from "./integrity";

function fileReader(path: string): ChunkReader {
  const fd = openSync(path, "r");
  return {
    read(n) {
      const buf = Buffer.alloc(n);
      const got = readSync(fd, buf, 0, n, null);
      return new Uint8Array(buf.subarray(0, got));
    },
    close: () => closeSync(fd),
  };
}

function tmpFile(bytes: Uint8Array): string {
  const path = join(mkdtempSync(join(tmpdir(), "boar-hash-")), "f.bin");
  writeFileSync(path, bytes);
  return path;
}

describe("sha256Chunked", () => {
  it("matches the NIST vector for 'abc'", async () => {
    const path = tmpFile(new TextEncoder().encode("abc"));
    expect(await sha256Chunked(fileReader(path))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("hashes an empty file", async () => {
    const path = tmpFile(new Uint8Array());
    expect(await sha256Chunked(fileReader(path))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("gives the same digest as a one-shot hash, whatever the chunk size (incl. non-aligned)", async () => {
    const big = randomBytes(3 * 1024 * 1024 + 12345);
    const small = big.subarray(0, 100_003);
    const cases: Array<[Buffer, number]> = [
      [small, 63], [small, 64], [small, 65], [big, 4096], [big, 1 << 20], [big, 8 << 20],
    ];
    for (const [data, chunkBytes] of cases) {
      const expected = createHash("sha256").update(data).digest("hex");
      expect(await sha256Chunked(fileReader(tmpFile(data)), { chunkBytes })).toBe(expected);
    }
    const tiny = randomBytes(1000);
    expect(await sha256Chunked(fileReader(tmpFile(tiny)), { chunkBytes: 1 })).toBe(
      createHash("sha256").update(tiny).digest("hex")
    );
  });

  it("never asks for more than one chunk at a time and reports monotonic progress", async () => {
    const data = randomBytes(1_000_000);
    const inner = fileReader(tmpFile(data));
    const requested: number[] = [];
    const progress: number[] = [];
    await sha256Chunked(
      { read: (n) => (requested.push(n), inner.read(n)), close: () => inner.close() },
      { chunkBytes: 65536, totalBytes: data.length, onProgress: (done) => progress.push(done) }
    );
    expect(Math.max(...requested)).toBe(65536);
    expect(progress.at(-1)).toBe(data.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("detects a single flipped bit", async () => {
    const data = randomBytes(200_000);
    const good = createHash("sha256").update(data).digest("hex");
    data[123_456] ^= 1;
    expect(await sha256Chunked(fileReader(tmpFile(data)))).not.toBe(good);
  });

  it("closes the reader even when a read fails", async () => {
    let closed = false;
    await expect(
      sha256Chunked({ read: () => { throw new Error("EIO"); }, close: () => { closed = true; } })
    ).rejects.toThrow("EIO");
    expect(closed).toBe(true);
  });
});

describe("catalog matching", () => {
  const catalog = [
    { id: "a", sizeBytes: 10, sha256: "aa".repeat(32) },
    { id: "b", sizeBytes: 10, sha256: "bb".repeat(32) },
    { id: "c", sizeBytes: 20, sha256: "cc".repeat(32) },
  ];

  it("narrows by size before hashing", () => {
    expect(candidatesBySize(catalog, 10).map((a) => a.id)).toEqual(["a", "b"]);
    expect(candidatesBySize(catalog, 11)).toEqual([]);
  });

  it("matches on size AND digest, case-insensitively", () => {
    expect(matchByDigest(catalog, 10, "BB".repeat(32))?.id).toBe("b");
    expect(matchByDigest(catalog, 20, "aa".repeat(32))).toBeNull();
    expect(matchByDigest(catalog, 10, "dd".repeat(32))).toBeNull();
  });

  it("digestsEqual ignores case and whitespace", () => {
    expect(digestsEqual("ABC\n", "abc")).toBe(true);
    expect(digestsEqual("abc", "abd")).toBe(false);
  });
});

describe("errorKindOf", () => {
  it("reads kind/permanent from AssetIntegrityError, else unknown/transient", () => {
    expect(errorKindOf(new AssetIntegrityError("hash-mismatch", "x", true))).toEqual({ kind: "hash-mismatch", permanent: true });
    expect(errorKindOf(new Error("boom"))).toEqual({ kind: "unknown", permanent: false });
  });
});

describe("cancellation", () => {
  it("stops between chunks with an AbortError and still closes the reader", async () => {
    const ctrl = new AbortController();
    let reads = 0;
    let closed = false;
    const p = sha256Chunked(
      {
        read: () => {
          reads++;
          if (reads === 3) ctrl.abort();
          return new Uint8Array(16);
        },
        close: () => {
          closed = true;
        },
      },
      { chunkBytes: 16, signal: ctrl.signal }
    );
    await expect(p).rejects.toBeInstanceOf(ImportAbortedError);
    expect(reads).toBe(3);
    expect(closed).toBe(true);
  });

  it("AbortError is recognisable by name and maps to a non-permanent 'cancelled'", () => {
    const e = new ImportAbortedError();
    expect(e.name).toBe("AbortError");
    expect(isAbortError(e)).toBe(true);
    expect(errorKindOf(e)).toEqual({ kind: "cancelled", permanent: false });
  });
});
