/**
 * 后台命令注册表。
 *
 * `exec_command` 启动的进程会登记在此，超过 yield 时间仍未结束时返回
 * `process_id`，后续通过 `write_stdin` 轮询、写入或终止。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripModelCredentialEnvironment } from "../providers.js";
import { lintShellCommand } from "./command-lint.js";
import { BoundedOutput } from "./process.js";
import { killProcessTree, trackDetachedChild } from "./process-tree.js";
import { sandboxCommand, type SandboxOptions } from "./sandbox.js";

/**
 * 进程结束后的保留时间：结束后仍然可以轮询到最终输出，而不是立刻变成
 * `Unknown process`。真踩过一次：`pnpm type-check | rg -c "error TS"` 退出后
 * 再轮询直接丢结果，只能重跑 1–2 分钟。
 */
export const FINISHED_RETENTION_MS = 10 * 60_000;
/** 同时保留的已结束进程上限，超出后淘汰最早结束的。 */
export const MAX_FINISHED_RECORDS = 20;

export interface ManagedResult {
  processId: string;
  running: boolean;
  output: string;
  /** 实际执行的命令（原样回显，便于核对 shell 展开）。 */
  command: string;
  /** 命令级的静态提示（如 rg -r 误用、长任务接 tail）。 */
  warnings: string[];
  /** true 表示该进程在本次轮询前就已结束，output 是保留输出的回放。 */
  replayed?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  sandbox: string;
}

export interface ManagedListEntry {
  processId: string;
  command: string;
  running: boolean;
  sandbox: string;
  exitCode?: number | null;
}

interface ManagedRecord {
  id: string;
  command: string;
  warnings: string[];
  child: ChildProcess;
  output: BoundedOutput;
  pending: string;
  running: boolean;
  timedOut: boolean;
  sandbox: string;
  exitCode?: number | null;
  finishedAt?: number;
  reapTimer?: NodeJS.Timeout;
  completion: Promise<void>;
  resolveCompletion: () => void;
  timeout: NodeJS.Timeout;
}

export interface StartOptions {
  cwd: string;
  sandbox: SandboxOptions;
  yieldTimeMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (result: ManagedResult) => void;
}

export class ManagedProcessRegistry {
  private readonly records = new Map<string, ManagedRecord>();

  async start(command: string, options: StartOptions): Promise<ManagedResult> {
    const invocation = sandboxCommand(command, options.cwd, options.sandbox);
    const env = stripModelCredentialEnvironment({ ...process.env });
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackDetachedChild(child);
    const id = randomUUID().slice(0, 12);
    let resolveCompletion = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: ManagedRecord = {
      id,
      command,
      warnings: lintShellCommand(command),
      child,
      output: new BoundedOutput(80_000),
      pending: "",
      running: true,
      timedOut: false,
      sandbox: invocation.description,
      completion,
      resolveCompletion,
      timeout: setTimeout(() => {
        record.timedOut = true;
        stopChild(record.child);
      }, options.timeoutMs),
    };
    record.timeout.unref();
    this.records.set(id, record);

    const append = (prefix: string, chunk: Buffer) => {
      const text = `${prefix}${chunk.toString("utf8")}`;
      record.output.append(text);
      record.pending = `${record.pending}${text}`.slice(-80_000);
      options.onOutput?.(this.snapshot(record));
    };
    child.stdout?.on("data", (chunk: Buffer) => append("", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("[stderr] ", chunk));
    child.once("error", (error) => append("[error] ", Buffer.from(error.message)));
    child.once("close", (exitCode) => {
      record.running = false;
      record.exitCode = exitCode;
      record.finishedAt = Date.now();
      clearTimeout(record.timeout);
      options.signal?.removeEventListener("abort", abort);
      record.resolveCompletion();
      // 结束后不立刻删除：后续 write_stdin 仍能回放到最终输出。
      this.scheduleReap(record);
    });
    const abort = () => stopChild(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Math.min(options.yieldTimeMs, 30_000)));
        timer.unref();
      }),
    ]);
    return this.result(record);
  }

  async interact(
    processId: string,
    options: { chars?: string; yieldTimeMs: number; terminate: boolean },
  ): Promise<ManagedResult> {
    const record = this.records.get(processId);
    if (!record) throw new Error(this.unknownProcessMessage(processId));
    if (options.terminate) stopChild(record.child);
    else if (options.chars && record.running) record.child.stdin?.write(options.chars);
    if (record.running) {
      await Promise.race([
        record.completion,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, Math.min(options.yieldTimeMs, 30_000)));
          timer.unref();
        }),
      ]);
    }
    // 已结束的进程保留在注册表里（有保留期），所以这里不删除记录。
    return this.result(record);
  }

  list(): ManagedListEntry[] {
    return [...this.records.values()].map((record) => ({
      processId: record.id,
      command: record.command,
      running: record.running,
      sandbox: record.sandbox,
      ...(record.running ? {} : { exitCode: record.exitCode }),
    }));
  }

  dispose(): void {
    for (const record of this.records.values()) {
      clearTimeout(record.timeout);
      if (record.reapTimer) clearTimeout(record.reapTimer);
      stopChild(record.child);
    }
    this.records.clear();
  }

  /** 未知 process_id 时给出已知进程清单与保留策略，而不是一句 Unknown process。 */
  private unknownProcessMessage(processId: string): string {
    const entries = this.list();
    const running = entries.filter((entry) => entry.running);
    const finished = entries.filter((entry) => !entry.running);
    const lines = [`Unknown process: ${processId}`];
    if (running.length) {
      lines.push(`Running: ${running.map((entry) => entry.processId).join(", ")}`);
    }
    if (finished.length) {
      lines.push(
        `Finished but still readable: ${finished
          .map((entry) => `${entry.processId} (exit ${entry.exitCode ?? "unknown"})`)
          .join(", ")}`,
      );
    }
    if (!entries.length) lines.push("No managed processes are known in this session.");
    lines.push(
      `Finished processes keep their final output for ${Math.round(FINISHED_RETENTION_MS / 60_000)} minutes; after that, re-run the command.`,
    );
    return lines.join("\n");
  }

  /** 结束后按保留期回收；同时限制保留数量，避免长会话无界增长。 */
  private scheduleReap(record: ManagedRecord): void {
    if (record.reapTimer) return;
    record.reapTimer = setTimeout(() => {
      this.records.delete(record.id);
    }, FINISHED_RETENTION_MS);
    record.reapTimer.unref?.();
    this.evictFinished();
  }

  private evictFinished(): void {
    const finished = [...this.records.values()]
      .filter((record) => !record.running)
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
    for (const record of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RECORDS))) {
      if (record.reapTimer) clearTimeout(record.reapTimer);
      this.records.delete(record.id);
    }
  }

  private result(record: ManagedRecord): ManagedResult {
    const pending = record.pending;
    record.pending = "";
    const finished = !record.running;
    // 结束后且没有新增输出：回放保留的最终输出，而不是「什么都没了」。
    const replayed = finished && !pending.trim();
    return {
      processId: record.id,
      running: record.running,
      output: pending || (finished ? record.output.value().trimEnd() || "(no output)" : "(no new output)"),
      command: record.command,
      warnings: record.warnings,
      ...(replayed ? { replayed: true } : {}),
      ...(finished ? { exitCode: record.exitCode } : {}),
      ...(record.timedOut ? { timedOut: true } : {}),
      sandbox: record.sandbox,
    };
  }

  /** 累计输出的实时快照（不清空增量）。 */
  private snapshot(record: ManagedRecord): ManagedResult {
    return {
      processId: record.id,
      running: record.running,
      output: record.output.value() || (record.running ? "…" : "(process completed)"),
      command: record.command,
      warnings: record.warnings,
      ...(!record.running ? { exitCode: record.exitCode } : {}),
      ...(record.timedOut ? { timedOut: true } : {}),
      sandbox: record.sandbox,
    };
  }
}

function stopChild(child: ChildProcess): void {
  if (child.killed || child.pid === undefined) return;
  killProcessTree(child.pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      killProcessTree(child.pid, "SIGKILL");
    }
  }, 1_500);
  timer.unref();
}
