import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TerminalEvent, TerminalInfo } from "../shared/types";
import { killProcessTree } from "./process-tree";

const OUTPUT_LIMIT = 160_000;
const INPUT_LIMIT = 32_000;

interface TerminalRecord {
  info: TerminalInfo;
  child: ChildProcessWithoutNullStreams;
  output: string;
}

/** User-owned interactive shells for the right-side Terminal panel. */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(private readonly emit: (event: TerminalEvent) => void) {}

  start(cwd: string): TerminalInfo {
    const shell = process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/zsh";
    const args = process.platform === "win32" ? ["/d", "/q"] : ["-i"];
    const id = `terminal-${randomUUID()}`;
    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const info: TerminalInfo = {
      id,
      cwd,
      shell,
      running: true,
      startedAt: Date.now(),
    };
    const record: TerminalRecord = { info, child, output: "" };
    this.terminals.set(id, record);
    const append = (data: Buffer | string) => {
      const text = data.toString();
      record.output = `${record.output}${text}`.slice(-OUTPUT_LIMIT);
      this.emit({ id, type: "output", data: text });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      record.info = { ...record.info, running: false };
      this.emit({ id, type: "error", message: error.message });
    });
    child.once("exit", (code) => {
      record.info = { ...record.info, running: false, exitCode: code };
      this.emit({ id, type: "exit", exitCode: code });
    });
    return record.info;
  }

  write(id: string, data: string): void {
    if (data.length > INPUT_LIMIT) throw new Error("Terminal input is too long.");
    const record = this.terminals.get(id);
    if (!record) throw new Error("Unknown terminal session.");
    if (!record.info.running || record.child.stdin.destroyed) throw new Error("Terminal session is not running.");
    record.child.stdin.write(data);
  }

  stop(id: string): void {
    const record = this.terminals.get(id);
    if (!record) return;
    if (record.child.pid !== undefined && record.info.running) killProcessTree(record.child.pid, "SIGTERM");
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((record) => ({ ...record.info }));
  }

  stopAll(): void {
    for (const record of this.terminals.values()) {
      if (record.child.pid !== undefined && record.info.running) killProcessTree(record.child.pid, "SIGTERM");
    }
    this.terminals.clear();
  }
}
