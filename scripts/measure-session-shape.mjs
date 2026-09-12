import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 量真实会话的**内容形状**，用来判断「流式每帧要处理多少文本」。
 *
 * 关心的两件事：
 * - 单条思考/正文最长有多少字符（真实上限，不是探针里的 5–12k）；
 * - 最长的那条思考被空行切成多少个块、最大块多大。
 *   第二条决定「只重算尾部」能省多少：块越小、越多，分段渲染的收益越大。
 *
 * 用法：node scripts/measure-session-shape.mjs [会话目录]
 */

const dir = process.argv[2] ?? path.join(os.homedir(), ".tacode", "sessions");
const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));

const rows = [];
for (const name of files) {
  const full = path.join(dir, name);
  const info = await stat(full);
  const raw = await readFile(full, "utf8");
  let records = 0;
  let bestThinking = "";
  let bestText = "";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    records += 1;
    const content = (entry.message ?? entry)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.thinking === "string" && part.thinking.length > bestThinking.length) bestThinking = part.thinking;
      if (part.type === "text" && typeof part.text === "string" && part.text.length > bestText.length) bestText = part.text;
    }
  }
  const chunks = bestThinking.split(/\n\s*\n/).map((chunk) => chunk.length).sort((a, b) => b - a);
  rows.push({
    name,
    bytes: info.size,
    records,
    chars: bestThinking.length,
    newlines: (bestThinking.match(/\n/g) ?? []).length,
    blocks: chunks.length,
    maxBlock: chunks[0] ?? 0,
    p90: chunks[Math.floor(chunks.length * 0.1)] ?? 0,
    textChars: bestText.length,
  });
}

rows.sort((a, b) => b.chars - a.chars);
console.log(`会话 ${rows.length} 个，合计 ${(rows.reduce((sum, row) => sum + row.bytes, 0) / 1e6).toFixed(1)}MB`);
console.log("  字节   记录  最长思考(换行)     块数  最大块  p90块  最长正文  文件");
for (const row of rows) {
  console.log(
    `${(row.bytes / 1e6).toFixed(1).padStart(6)}MB ${String(row.records).padStart(5)}` +
    ` ${String(row.chars).padStart(7)}(${String(row.newlines).padStart(5)})` +
    ` ${String(row.blocks).padStart(6)} ${String(row.maxBlock).padStart(6)} ${String(row.p90).padStart(6)}` +
    ` ${String(row.textChars).padStart(8)}  ${row.name.slice(0, 30)}`,
  );
}
