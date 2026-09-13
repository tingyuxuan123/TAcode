/**
 * 工作区路径解析与越界防护。
 *
 * 写入类路径（write_file / edit_file / apply_patch / checkpoint）必须经过
 * `resolve()`：既做词法校验，也用 `realpath` 校验符号链接不会指向工作区之外。
 *
 * 读取类路径（read_file / search_files / list_files）走 `resolveForRead()`，
 * 不设工作区边界：exec_command 在沙箱里本就允许读取宿主任意文件，只锁文件工具
 * 拦不住任何东西，却会让绑定到子目录会话里的子代理在路径试探上空转
 * （list_files / exec 放行、read_file 拒绝的组合曾把轮次烧在换路径重试上）。
 * 读取外泄的真实闸门是网络默认关闭，而不是读路径校验。
 */

import fs from "node:fs/promises";
import path from "node:path";

export class Workspace {
  readonly root: string;
  private realRoot?: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    const stat = await fs.stat(this.root);
    if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${this.root}`);
    this.realRoot = await fs.realpath(this.root);
  }

  async resolve(userPath: string, allowMissing = false): Promise<string> {
    if (userPath.includes("\0")) throw new Error("Path contains a null byte");
    const candidate = path.resolve(this.root, userPath);
    this.assertLexicallyInside(candidate);
    if (!this.realRoot) await this.initialize();
    try {
      const real = await fs.realpath(candidate);
      this.assertReallyInside(real);
      return candidate;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT" || !allowMissing) throw error;
    }
    const existingParent = await this.findExistingParent(path.dirname(candidate));
    const realParent = await fs.realpath(existingParent);
    this.assertReallyInside(realParent);
    return candidate;
  }

  /**
   * 只读解析：接受任意绝对路径与含 `..` 的相对路径，符号链接按文件系统原样跟随。
   * 不做 realpath 校验——读取没有越界写风险，边界防护只对写入通道有意义。
   */
  resolveForRead(userPath: string): string {
    if (userPath.includes("\0")) throw new Error("Path contains a null byte");
    return path.resolve(this.root, userPath);
  }

  relative(absolutePath: string): string {
    return path.relative(this.root, absolutePath) || ".";
  }

  private assertLexicallyInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        [
          `Path escapes workspace: ${candidate}`,
          `workspace root: ${this.root}`,
          'Write tools only accept paths inside the workspace. Use a workspace-relative path (e.g. "src/app.ts"); to write to another directory, open that directory as the project.',
        ].join("\n"),
      );
    }
  }

  private assertReallyInside(candidate: string): void {
    const relative = path.relative(this.realRoot ?? this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        [
          `Path resolves outside workspace: ${candidate}`,
          `workspace root: ${this.realRoot ?? this.root}`,
          "The path goes through a symlink that leads outside the workspace; use the real path inside the workspace instead.",
        ].join("\n"),
      );
    }
  }

  private async findExistingParent(start: string): Promise<string> {
    let current = start;
    for (;;) {
      try {
        await fs.access(current);
        return current;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing parent for path: ${start}`);
      current = parent;
    }
  }
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
