import readline from "node:readline";
import { writeFileSync } from "node:fs";

if (process.env.MCP_FIXTURE_PID_FILE) writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (process.env.MCP_FIXTURE_HANG === "1") continue;
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "TACode test MCP", version: "1.0.0" } });
  else if (message.method === "tools/list") reply(message.id, message.params?.cursor ? {
    tools: [{ name: "fail", description: "Return a controlled error", inputSchema: { type: "object", properties: {} } }],
  } : { tools: [{ name: "echo", description: "Echo input without external effects", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], nextCursor: "page-2" });
  else if (message.method === "tools/call") reply(message.id, message.params.name === "fail" ? { isError: true, content: [{ type: "text", text: "fixture failure" }] } : {
    content: [{ type: "text", text: message.params.arguments.text }], structuredContent: { text: message.params.arguments.text, configured: process.env.MCP_FIXTURE_VALUE, unconfigured: process.env.TACODE_MCP_UNSHARED_SECRET, cwd: process.cwd() },
  });
  else if (message.method === "ping") reply(message.id, {});
  else process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } })}\n`);
}
