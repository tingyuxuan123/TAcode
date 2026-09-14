import { spawn } from "node:child_process";
import type { GitErrorCode } from "../../shared/git";

export class GitReadError extends Error {
  constructor(readonly code: GitErrorCode, message: string, readonly details?: string) {
    super(message);
    this.name = "GitReadError";
  }
}

export interface GitRunOptions {
  /** Main-process generated alternate index; never accepted from renderer input. */
  indexFile?: string;
  input?: Buffer | string;
  signal?: AbortSignal;
  allowExitCodes?: readonly number[];
  maxBytes?: number;
  timeoutMs?: number;
}

export class GitProcess {
  constructor(private readonly executable = "git") {}

  async run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<Buffer> {
    if (options.signal?.aborted) throw new GitReadError("cancelled", "Git operation was cancelled");
    const env = { ...process.env };
    // A desktop launch from a shell/worktree must not redirect another project's
    // index, object database or working tree through inherited environment.
    for (const name of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|NAMESPACE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXTERNAL_DIFF|DIFF_OPTS|TRACE.*)$/.test(name)) delete env[name];
    }
    Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" });
    if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-c", "diff.suppressBlankEmpty=false", ...args], {
        cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      let size = 0;
      let errorSize = 0;
      let failure: Error | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill();
        escalation ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        escalation.unref();
      };
      const abort = () => stop(new GitReadError("cancelled", "Git operation was cancelled"));
      const timer = setTimeout(() => stop(new GitReadError("timedOut", "Git operation timed out")), options.timeoutMs ?? 30_000);
      const finish = (error?: Error, value?: Buffer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value ?? Buffer.alloc(0));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.maxBytes ?? 64 * 1024 * 1024)) stop(new GitReadError("outputLimit", "Git output exceeded the configured limit"));
        else if (!failure) chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorSize < 256 * 1024) errorChunks.push(chunk.subarray(0, 256 * 1024 - errorSize));
        errorSize += chunk.length;
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") failure ??= error; });
      child.on("error", (error: NodeJS.ErrnoException) => finish(new GitReadError(error.code === "ENOENT" ? "missingGit" : "failed", error.message)));
      child.on("close", (code) => {
        if (failure) return finish(failure);
        if (code !== 0 && !options.allowExitCodes?.includes(code ?? -1)) {
          const stderr = Buffer.concat(errorChunks).toString("utf8").trim();
          return finish(new GitReadError("failed", stderr || `Git exited with code ${code}`, stderr));
        }
        finish(undefined, Buffer.concat(chunks, size));
      });
      child.stdin.end(options.input);
    });
  }
}

export function decodeGitText(buffer: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new GitReadError("invalidOutput", "Git returned a non-UTF-8 path or text response"); }
}

/** rev-parse outputs exactly one terminating LF; path whitespace is meaningful. */
export function gitOutputLine(buffer: Buffer): string {
  return decodeGitText(buffer).replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, "");
}
