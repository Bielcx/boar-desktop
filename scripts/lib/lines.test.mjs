import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { lines } from "./lines.mjs";

describe("lines", () => {
  it("splits on \\n only, keeping U+2028 and lone \\r inside a record, across chunk and UTF-8 boundaries", async () => {
    const text = `${JSON.stringify({ d: "a b\rc" })}\r\n\n{"x":"é"}`;
    const bytes = Buffer.from(text, "utf8");
    const cut = bytes.indexOf(0xa9); // inside "é"
    const out = [];
    for await (const l of lines(Readable.from([bytes.subarray(0, 5), bytes.subarray(5, cut), bytes.subarray(cut)]))) out.push(JSON.parse(l));
    expect(out).toEqual([{ d: "a b\rc" }, { x: "é" }]);
  });
});
