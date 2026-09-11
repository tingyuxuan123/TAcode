import fsp from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./ipc-validation";

/**
 * 本地诊断日志：只写本机、限大小、可轮转，不上传。
 *
 * 约束（与稳定性方案一致）：
 * - 不记录 API key / prompt 原文 / 完整代码：写入前对已知凭据脱敏，并对单条
 *   message / details 做长度截断。
 * - 写入失败绝不影响主流程（诊断是尽力而为），失败时至少保留内存里的最近若干条。
 * - 同一路径的写入串行化，避免并发 append 交错。
 */

export type LogLevel = "info" | "warn" | "error";

/** AgentHost 等模块只依赖这个窄接口，便于测试替身。 */
export interface DiagnosticSink {
  info(scope: string, message: string, details?: unknown): void;
  warn(scope: string, message: string, details?: unknown): void;
  error(scope: string, message: string, details?: unknown): void;
}

export interface LocalLoggerOptions {
  /** 日志目录（通常 ~/.tacode/logs）。 */
  dir: string;
  fileName?: string;
  /** 单个文件大小上限，超过即轮转。 */
  maxBytes?: number;
  /** 保留的历史文件个数（tacode.log.1 … .N）。 */
  maxFiles?: number;
  /** 需要脱敏的凭据来源；每次写入时求值，便于跟随运行时配置变化。 */
  secrets?: () => Array<string | undefined>;
  now?: () => Date;
}

const MAX_MESSAGE_CHARS = 500;
const MAX_DETAILS_CHARS = 2_000;
const RECENT_CAP = 200;

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export class LocalLogger implements DiagnosticSink {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  private readonly secrets: () => Array<string | undefined>;
  private queue: Promise<void> = Promise.resolve();
  private recentEntries: string[] = [];

  constructor(options: LocalLoggerOptions) {
    this.file = path.join(options.dir, options.fileName ?? "tacode.log");
    this.maxBytes = Math.max(1_024, options.maxBytes ?? 1_048_576);
    this.maxFiles = Math.max(1, options.maxFiles ?? 3);
    this.now = options.now ?? (() => new Date());
    this.secrets = options.secrets ?? (() => []);
  }

  get filePath(): string {
    return this.file;
  }

  info(scope: string, message: string, details?: unknown): void {
    this.log("info", scope, message, details);
  }

  warn(scope: string, message: string, details?: unknown): void {
    this.log("warn", scope, message, details);
  }

  error(scope: string, message: string, details?: unknown): void {
    this.log("error", scope, message, details);
  }

  log(level: LogLevel, scope: string, message: string, details?: unknown): void {
    const line = this.format(level, scope, message, details);
    this.recentEntries.push(line);
    if (this.recentEntries.length > RECENT_CAP)
      this.recentEntries.splice(0, this.recentEntries.length - RECENT_CAP);
    this.queue = this.queue.then(
      () => this.append(line),
      () => this.append(line),
    );
  }

  /** 等待队列中的写入落盘（测试与退出前收尾用）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** 内存中的最近若干条（磁盘不可写时仍可展示）。 */
  recent(limit = 50): string[] {
    return this.recentEntries.slice(-limit);
  }

  /** 读取磁盘尾部；文件不可读时回退到内存缓冲。 */
  async tail(limit = 200): Promise<string[]> {
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      return lines.slice(-limit);
    } catch {
      return this.recent(limit);
    }
  }

  private format(
    level: LogLevel,
    scope: string,
    message: string,
    details: unknown,
  ): string {
    const secrets = this.secrets();
    const entry = {
      ts: this.now().toISOString(),
      level,
      scope,
      message: redactSecrets(String(message).slice(0, MAX_MESSAGE_CHARS), secrets),
      ...(details === undefined
        ? {}
        : {
            details: redactSecrets(
              safeJson(details).slice(0, MAX_DETAILS_CHARS),
              secrets,
            ),
          }),
    };
    return JSON.stringify(entry);
  }

  private async append(line: string): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await this.rotateIfNeeded(Buffer.byteLength(line, "utf8") + 1);
      await fsp.appendFile(this.file, `${line}\n`, { mode: 0o600 });
    } catch {
      // 诊断写入失败不影响主流程。
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(this.file)).size;
    } catch {
      return;
    }
    if (size + incomingBytes <= this.maxBytes) return;
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await fsp
        .rename(`${this.file}.${index}`, `${this.file}.${index + 1}`)
        .catch(() => undefined);
    }
    await fsp.rename(this.file, `${this.file}.1`).catch(() => undefined);
  }
}
