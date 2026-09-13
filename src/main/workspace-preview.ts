import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { WorkspaceReadResult } from "../shared/types";
import { IPC_LIMITS } from "./ipc-validation";

/** 状态/截断说明放在元数据中，复制正文不会混入提示文案。 */
export async function readWorkspacePreview(file: string, relativePath: string, maxBytes = IPC_LIMITS.workspaceReadBytes): Promise<WorkspaceReadResult> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("这不是可预览的普通文件");
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const content = buffer.subarray(0, offset);
      const binary = content.includes(0);
      const truncated = stat.size > offset;
      const decoder = new StringDecoder("utf8");
      return { path: relativePath, status: binary ? "binary" : "ready", binary, content: binary ? "" : truncated ? decoder.write(content) : content.toString("utf8"), truncated, size: stat.size, version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relativePath, status: "missing", content: "", binary: false, size: 0 };
    throw error;
  }
}
