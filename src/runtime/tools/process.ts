/**
 * 一次性命令执行与有界输出缓冲。
 *
 * 输出按「头部 75% + 尾部 25%」截断，避免长日志把模型上下文打满。
 * 启动子进程前会剥离模型凭据环境变量，防止凭据泄漏给任意命令。
 */

import { spawn } from "node:child_process";
import { stripModelCredentialEnvironment } from "../providers.js";
import { killProcessTree, trackDetachedChild } from "./process-tree.js";

export interface RunProcessOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: string | boolean;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const env = stripModelCredentialEnvironment({ ...process.env });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      shell: options.shell ?? false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackDetachedChild(child);
    const stdoutBuffer = new BoundedOutput(Math.floor(maxOutputBytes / 2));
    const stderrBuffer = new BoundedOutput(Math.ceil(maxOutputBytes / 2));
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => stdoutBuffer.append(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderrBuffer.append(chunk.toString("utf8")));
    const stop = () => {
      if (child.killed || child.pid === undefined) return;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          killProcessTree(child.pid, "SIGKILL");
        }
      }, 1_500).unref();
    };
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: stdoutBuffer.value(),
        stderr: stderrBuffer.value(),
        exitCode,
        timedOut,
        truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
      });
    });
  });
}

export class BoundedOutput {
  private readonly limit: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = "";
  private tail = "";
  private seen = 0;

  constructor(limit: number) {
    this.limit = limit;
    this.headLimit = Math.floor(limit * 0.75);
    this.tailLimit = limit - this.headLimit;
  }

  get truncated(): boolean {
    return this.seen > this.limit;
  }

  append(chunk: string): void {
    this.seen += chunk.length;
    let remaining = chunk;
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, remaining.length);
      this.head += remaining.slice(0, take);
      remaining = remaining.slice(take);
    }
    if (remaining) this.tail = `${this.tail}${remaining}`.slice(-this.tailLimit);
  }

  value(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n... output truncated; tail follows ...\n${this.tail}`;
  }
}
