export interface DrainResult {
  rest: Buffer;
  lines: string[];
  /** 超过单行上限被丢弃的行数（含被丢弃的超长未完成片段）。 */
  oversized: number;
}

/** Split newline-delimited RPC stdout without breaking UTF-8 code points across chunks. */
export function drainUtf8Lines(
  buffer: Buffer,
  chunk: Buffer,
  options: { maxLineBytes?: number } = {},
): DrainResult {
  const maxLineBytes = options.maxLineBytes ?? 0;
  const combined = Buffer.concat([buffer, chunk]);
  const lines: string[] = [];
  let oversized = 0;
  let start = 0;
  let index = combined.indexOf(0x0a, start);
  while (index >= 0) {
    const length = index - start;
    if (maxLineBytes > 0 && length > maxLineBytes) {
      // 超长行直接丢弃：畸形/恶意输出不应把主进程内存撑爆。
      oversized += 1;
    } else {
      const line = combined
        .subarray(start, index)
        .toString("utf8")
        .replace(/\r$/, "");
      if (line) lines.push(line);
    }
    start = index + 1;
    index = combined.indexOf(0x0a, start);
  }
  let rest = Buffer.from(combined.subarray(start)) as Buffer;
  if (maxLineBytes > 0 && rest.length > maxLineBytes) {
    // 一直没有换行且已超上限：丢弃缓冲，避免无界增长。
    rest = Buffer.alloc(0);
    oversized += 1;
  }
  return { rest, lines, oversized };
}
