/**
 * 后台命令注册表。
 *
 * `exec_command` 启动的进程会登记在此，超过 yield 时间仍未结束时返回
 * `process_id`，后续通过 `write_stdin` 轮询、写入或终止。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripModelCredentialEnvironment } from "../providers.js";
import { BoundedOutput } from "./process.js";
import { killProcessTree, trackDetachedChild } from "./process-tree.js";
import { sandboxCommand, type SandboxOptions } from "./sandbox.js";

export interface ManagedResult {
  processId: string;
  running: boolean;
  output: string;
  exitCode?: number | null;
  timedOut?: boolean;
  sandbox: string;
}

export interface ManagedListEntry {
  processId: string;
  command: string;
  running: boolean;
  sandbox: string;
}

interface ManagedRecord {
  id: string;
  command: string;
  child: ChildProcess;
  output: BoundedOutput;
  pending: string;
  running: boolean;
  timedOut: boolean;
  sandbox: string;
  exitCode?: number | null;
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
      clearTimeout(record.timeout);
      options.signal?.removeEventListener("abort", abort);
      record.resolveCompletion();
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
    if (!record) throw new Error(`Unknown process: ${processId}`);
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
    const result = this.result(record);
    if (!record.running) this.records.delete(processId);
    return result;
  }

  list(): ManagedListEntry[] {
    return [...this.records.values()].map((record) => ({
      processId: record.id,
      command: record.command,
      running: record.running,
      sandbox: record.sandbox,
    }));
  }

  dispose(): void {
    for (const record of this.records.values()) {
      clearTimeout(record.timeout);
      stopChild(record.child);
    }
    this.records.clear();
  }

  private result(record: ManagedRecord): ManagedResult {
    const pending = record.pending;
    record.pending = "";
    return {
      processId: record.id,
      running: record.running,
      output: pending || (record.running ? "(no new output)" : "(process completed)"),
      ...(!record.running ? { exitCode: record.exitCode } : {}),
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
