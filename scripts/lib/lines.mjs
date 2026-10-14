// Newline-delimited records from a stream, split on "\n" only. node:readline
// also ends lines at "\r", U+2028 and U+2029, which OpenStreetMap text (and
// JSON.stringify output, which leaves U+2028 unescaped) can contain inside a
// JSON string: a record would be cut in two.
import { StringDecoder } from "node:string_decoder";

/** Lines of `stream` (a trailing "\r" is dropped, empty lines skipped). */
export async function* lines(stream) {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for await (const chunk of stream) {
    const parts = (rest + (typeof chunk === "string" ? chunk : decoder.write(chunk))).split("\n");
    rest = parts.pop();
    for (const p of parts) if (p) yield p.endsWith("\r") ? p.slice(0, -1) : p;
  }
  rest += decoder.end();
  if (rest) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
}
