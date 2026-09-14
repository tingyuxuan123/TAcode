import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExternalEditor, FileOpenRequest, ProjectPath } from "../../shared/files";
import { ProjectFileError, ProjectFilePaths } from "./file-path";

export interface FileExternalOptions {
  openPath?(file: string): Promise<string>;
  reveal?(file: string): void;
  editorCandidates?(editor: "vscode" | "cursor"): string[];
  launch?(executable: string, args: string[]): Promise<void>;
}
export function editorCandidates(editor: "vscode" | "cursor", platform = process.platform, env = process.env, home = os.homedir()): string[] {
  if (platform === "darwin") {
    const app = editor === "vscode" ? "Visual Studio Code.app" : "Cursor.app";
    return ["/Applications", path.join(home, "Applications")].flatMap((root) => (editor === "vscode" ? ["code"] : ["cursor", "code"]).map((name) => path.join(root, app, "Contents/Resources/app/bin", name)));
  }
  if (platform === "win32") {
    const app = editor === "vscode" ? "Microsoft VS Code" : "cursor"; const executable = editor === "vscode" ? "Code.exe" : "Cursor.exe";
    return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]].filter((root): root is string => Boolean(root)).map((root) => path.win32.join(root, app, executable));
  }
  return [...new Set([...(env.PATH ?? "").split(path.delimiter).filter(Boolean), "/usr/bin", "/usr/local/bin", "/snap/bin"])].map((root) => path.join(root, editor === "vscode" ? "code" : "cursor"));
}
export function launchEditor(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { shell: false, detached: true, stdio: "ignore", env });
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.unref(); if (error) reject(error); else resolve(); };
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`Editor launch failed (${signal ?? code})`)));
    child.once("spawn", () => { timer = process.platform === "win32" ? setTimeout(() => finish(), 500)
      : setTimeout(() => finish(new Error("The editor CLI did not complete within 15 seconds")), 15_000); });
  });
}
export class FileExternal {
  constructor(private readonly paths: ProjectFilePaths, private readonly options: FileExternalOptions) {}
  private async executable(editor: "vscode" | "cursor"): Promise<string | undefined> {
    for (const candidate of (this.options.editorCandidates ?? editorCandidates)(editor)) {
      try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } } catch { /* Try the next installed location. */ }
    }
  }
  async editors(): Promise<ExternalEditor[]> {
    const result: ExternalEditor[] = ["system"];
    for (const editor of ["vscode", "cursor"] as const) if (await this.executable(editor)) result.push(editor);
    return result;
  }
  async open(request: FileOpenRequest, active: () => void): Promise<void> {
    const bound = await this.paths.resolve(request, true);
    if (!bound.exists) throw new ProjectFileError("missing", "The selected entry no longer exists");
    for (const value of [request.line, request.column]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000)) throw new ProjectFileError("invalidRequest", "Invalid editor location");
    if (request.editor === "system") {
      if (!this.options.openPath) throw new ProjectFileError("unavailable", "System opening is unavailable");
      active(); const error = await this.options.openPath(bound.lexicalFile); if (error) throw new ProjectFileError("failed", error); return;
    }
    if (request.editor !== "vscode" && request.editor !== "cursor") throw new ProjectFileError("invalidRequest", "Unknown external editor");
    const executable = await this.executable(request.editor);
    if (!executable) throw new ProjectFileError("unavailable", "The selected editor is not installed");
    const stat = await fs.stat(bound.file);
    const args = stat.isDirectory() ? [bound.lexicalFile] : ["--goto", `${bound.lexicalFile}:${request.line ?? 1}:${request.column ?? 1}`];
    const checked = await this.paths.resolve(request, true);
    if (!checked.exists || checked.file !== bound.file) throw new ProjectFileError("conflict", "The selected path changed before opening");
    active(); await (this.options.launch ?? launchEditor)(executable, args);
  }
  async reveal(request: ProjectPath, active: () => void): Promise<void> {
    const bound = request.path ? await this.paths.entry(request) : await this.paths.resolve(request, true);
    if (!bound.exists) throw new ProjectFileError("missing", "The selected entry no longer exists");
    if (!this.options.reveal) throw new ProjectFileError("unavailable", "File manager opening is unavailable");
    active(); this.options.reveal(bound.lexicalFile);
  }
}
