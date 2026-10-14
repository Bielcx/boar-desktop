/**
 * The Model Context Protocol, the small part BOAR needs (desktop/docs/09-mcp.md): JSON-RPC 2.0, one message per line
 * on stdio. initialize, ping, tools/list and tools/call; notifications get no answer. No resources, prompts or
 * sampling: the server only answers searches. Pure (no I/O), so a test drives it message by message.
 */

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the result as text; a thrown Error becomes a tool error (isError) the client's model can read. */
  call(args: Record<string, unknown>): Promise<{ text: string; structured?: Record<string, unknown> }>;
}

type Id = string | number | null;
type Response = { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string } };

/** Newest first; tools work the same in all of them. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const error = (id: Id, code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Answers one line from the client: a JSON-RPC response, or null for a notification (and for anything without an id). */
export async function handleLine(line: string, tools: Tool[], server: { name: string; version: string }): Promise<Response | null> {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return error(null, -32700, "Parse error");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // A response from the client (we send no requests) or garbage: nothing to answer unless it carries an id.
    return msg && typeof msg === "object" && "id" in msg && !("result" in msg || "error" in msg)
      ? error(msg.id ?? null, -32600, "Invalid Request")
      : null;
  }
  const isRequest = "id" in msg && (typeof msg.id === "string" || typeof msg.id === "number");
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled...
  const id: Id = msg.id;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const ok = (result: unknown): Response => ({ jsonrpc: "2.0", id, result });

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: server,
        instructions:
          "Searches the user's offline BOAR library (their imported documents first). Cite the source of each passage you use.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return error(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
      try {
        const { text, structured } = await tool.call(args);
        return ok({ content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}), isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: String((e as Error)?.message ?? e) }], isError: true });
      }
    }
    default:
      return error(id, -32601, `Method not found: ${msg.method}`);
  }
}
