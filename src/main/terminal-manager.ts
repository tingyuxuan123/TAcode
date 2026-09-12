import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { TerminalEvent, TerminalInfo } from "../shared/types";
import { killProcessTree } from "./process-tree";

const OUTPUT_LIMIT = 160_000;
const INPUT_LIMIT = 32_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** node-pty 的最小结构化类型（完整类型随包提供，这里只约束我们用到的方法）。 */
export interface PtyTerminal {
  pid: number | undefined;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string | undefined>;
  }): PtyTerminal;
}

/**
 * node-pty 是按 Electron ABI 编译的原生模块：必须在主进程里 lazy 加载，
 * 缺失/未按 Electron 重建时抛出可读错误，而不是让应用启动即崩。
 */
function loadPty(): PtyModule {
  const require = createRequire(import.meta.url);
  return require("node-pty") as PtyModule;
}

interface TerminalRecord {
  info: TerminalInfo;
  child: PtyTerminal;
}

/** User-owned interactive shells for the right-side Terminal panel. */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(
    private readonly emit: (event: TerminalEvent) => void,
    private readonly loadPtyModule: () => PtyModule = loadPty,
  ) {}

  start(cwd: string): TerminalInfo {
    let pty: PtyModule;
    try {
      pty = this.loadPtyModule();
    } catch (error) {
      throw new Error(`终端依赖 (node-pty) 未就绪：${error instanceof Error ? error.message : String(error)}`);
    }
    const shell = process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/zsh";
    const args = process.platform === "win32" ? ["/d", "/q"] : ["-i"];
    const id = `terminal-${randomUUID()}`;
    // 真伪终端：shell 认为自己在终端里运行，ANSI 颜色 / vim / htop / 干净的提示符都因此可用。
    const child = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
    });
    const info: TerminalInfo = {
      id,
      cwd,
      shell,
      running: true,
      startedAt: Date.now(),
    };
    const record: TerminalRecord = { info, child };
    this.terminals.set(id, record);
    child.onData((data) => {
      this.emit({ id, type: "output", data: data.slice(-OUTPUT_LIMIT) });
    });
    child.onExit(({ exitCode }) => {
      record.info = { ...record.info, running: false, exitCode };
      this.emit({ id, type: "exit", exitCode });
    });
    return record.info;
  }

  write(id: string, data: string): void {
    if (data.length > INPUT_LIMIT) throw new Error("Terminal input is too long.");
    const record = this.terminals.get(id);
    if (!record) throw new Error("Unknown terminal session.");
    if (!record.info.running) throw new Error("Terminal session is not running.");
    record.child.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 500) {
      throw new Error("Terminal size out of range.");
    }
    const record = this.terminals.get(id);
    if (!record) throw new Error("Unknown terminal session.");
    if (!record.info.running) throw new Error("Terminal session is not running.");
    record.child.resize(cols, rows);
  }

  stop(id: string): void {
    const record = this.terminals.get(id);
    if (!record) return;
    if (record.child.pid !== undefined && record.info.running) {
      // 先标记再杀：exit 事件在 PTY 下是异步到达的，UI 不能依赖它才知道已停止。
      record.info = { ...record.info, running: false };
      killProcessTree(record.child.pid, "SIGTERM");
      record.child.kill();
    }
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((record) => ({ ...record.info }));
  }

  stopAll(): void {
    for (const record of this.terminals.values()) {
      if (record.child.pid !== undefined && record.info.running) {
        record.info = { ...record.info, running: false };
        killProcessTree(record.child.pid, "SIGTERM");
        record.child.kill();
      }
    }
    this.terminals.clear();
  }
}
