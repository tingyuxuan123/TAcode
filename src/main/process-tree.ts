import { execFile } from "node:child_process";

interface ProcessInfo { pid: number; ppid: number; pgid: number; started: string }
let pendingTable: Promise<Map<number, ProcessInfo>> | undefined;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout: 1500, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** 同时停止多个 worker 时共用一次异步 ps，避免为每个后代反复启动 pgrep。 */
async function processTable(): Promise<Map<number, ProcessInfo>> {
  pendingTable ??= run("ps", ["-axo", "pid=,ppid=,pgid=,lstart="]).then((output) => {
    const rows = new Map<number, ProcessInfo>();
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match) rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] });
    }
    return rows;
  }).catch(() => new Map<number, ProcessInfo>()).finally(() => { pendingTable = undefined; });
  return pendingTable;
}

function descendants(pid: number, table: Map<number, ProcessInfo>): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of table.values()) { const rows = children.get(info.ppid) ?? []; rows.push(info); children.set(info.ppid, rows); }
  const found: ProcessInfo[] = [];
  const seen = new Set<number>();
  const pending = [pid];
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next) || next === process.pid) continue;
    seen.add(next);
    const info = table.get(next);
    if (info) found.push(info);
    for (const child of children.get(next) ?? []) pending.push(child.pid);
  }
  return found;
}

function signal(pid: number, value: NodeJS.Signals): void {
  try { process.kill(pid, value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function signalTree(pid: number, rows: ProcessInfo[], table: Map<number, ProcessInfo>, value: NodeJS.Signals): void {
  const ownGroup = table.get(process.pid)?.pgid;
  const groups = new Set(ownGroup === undefined ? [] : rows.map((row) => row.pgid).filter((pgid) => pgid > 0 && pgid !== ownGroup));
  // 所有调用点的根进程由 TACode 启动；worker/PTY 有独立进程组。
  // 根已退出时依然回收其组内成员，但绝不向当前应用自身的组发送信号。
  if (pid !== ownGroup) groups.add(pid);
  for (const group of groups) signal(-group, value);
  for (const row of [...rows].reverse()) if (row.pid !== process.pid) signal(row.pid, value);
  signal(pid, value);
}

const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;

/** 退出事件的最后清理也可调用；无需阻塞主进程查询每一级后代。 */
export async function killProcessTree(pid: number, value: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (!valid(pid)) return;
  if (process.platform === "win32") {
    try { await run("taskkill.exe", ["/pid", String(pid), "/t", "/f"]); }
    catch { signal(pid, value); }
    return;
  }
  const table = await processTable();
  signalTree(pid, descendants(pid, table), table, value);
}

async function waitForExit(exited: Promise<void> | undefined, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited ?? new Promise<void>(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

/** 保留 TERM 前的身份，根进程先退出时仍能清掉忽略 TERM 的独立子进程组。 */
export async function terminateProcessTree(pid: number, options: { exited?: Promise<void>; graceMs?: number } = {}): Promise<void> {
  if (!valid(pid)) return;
  if (process.platform === "win32") { await killProcessTree(pid); await waitForExit(options.exited, 500); return; }
  const before = await processTable();
  const captured = descendants(pid, before);
  signalTree(pid, captured, before, "SIGTERM");
  await waitForExit(options.exited, options.graceMs ?? 2000);
  const after = await processTable();
  const survivors = new Map<number, ProcessInfo>();
  for (const old of captured) {
    const current = after.get(old.pid);
    // 已退出的后代可能重新归属 init；以启动时间核对，避免把复用的 PID 当作旧后代。
    if (current?.started === old.started) for (const row of descendants(old.pid, after)) survivors.set(row.pid, row);
  }
  const root = after.get(pid);
  const originalRoot = before.get(pid);
  if (!root || (originalRoot && root.started === originalRoot.started)) signalTree(pid, [...survivors.values()], after, "SIGKILL");
  await waitForExit(options.exited, 500);
}
