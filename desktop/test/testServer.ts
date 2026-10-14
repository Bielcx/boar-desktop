import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local HTTP server for download tests: serves `body` at any path, honours "Range: bytes=N-" with 206, writes in
 * 64 KiB pieces with `delayMs` between them, and can cut the connection after `dropAt` bytes (once). A Range starting
 * at or past the end gets 416 with "Content-Range: bytes *\/<size>". `redirect` answers every request with a 302 there.
 */
export async function serve(
  body: Buffer,
  opts: { delayMs?: number; dropAt?: number; ignoreRange?: boolean; status?: number; redirect?: string } = {}
) {
  const ranges: string[] = [];
  let dropAt = opts.dropAt;
  const server: Server = createServer(async (req, res) => {
    const range = req.headers.range;
    ranges.push(range ?? "");
    if (opts.redirect) {
      res.writeHead(302, { location: opts.redirect });
      return res.end();
    }
    if (opts.status) {
      res.writeHead(opts.status, { "content-type": "text/plain" });
      return res.end("rate limited");
    }
    const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    if (from >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      return res.end();
    }
    const part = body.subarray(from);
    res.writeHead(from > 0 ? 206 : 200, { "content-length": String(part.length), "content-type": "application/octet-stream" });
    for (let i = 0; i < part.length; i += 65536) {
      if (dropAt !== undefined && from + i >= dropAt) {
        dropAt = undefined;
        res.destroy();
        return;
      }
      res.write(part.subarray(i, i + 65536));
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (res.destroyed) return;
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/file.bin`,
    ranges,
    close: () => new Promise<void>((r) => (server.close(() => r()), server.closeAllConnections())),
  };
}
