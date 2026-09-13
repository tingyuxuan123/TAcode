import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { killProcessTree, terminateProcessTree } from "./process-tree";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.skipIf(process.platform === "win32")("shares asynchronous process discovery, excludes the application group, and does not block other work", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const queries: Array<(error: null, stdout: string) => void> = [];
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => { queries.push(callback); return {}; }) as unknown as typeof execFile);
  const a = killProcessTree(91001);
  const b = killProcessTree(91002);
  expect(execFile).toHaveBeenCalledTimes(1);
  let yielded = false;
  await new Promise<void>((resolve) => setTimeout(() => { yielded = true; resolve(); }, 5));
  expect(yielded).toBe(true);
  expect(kill).not.toHaveBeenCalled();
  queries[0](null, `${process.pid} 1 80000 now\n91001 ${process.pid} 91001 first\n91002 ${process.pid} 80000 second\n91003 91001 91003 third\n`);
  await Promise.all([a, b]);
  expect(kill).toHaveBeenCalledWith(-91003, "SIGKILL");
  expect(kill).not.toHaveBeenCalledWith(-80000, expect.anything());
  expect(kill).not.toHaveBeenCalledWith(process.pid, expect.anything());
});

it.skipIf(process.platform === "win32")("retains reparented children for escalation but does not kill a reused PID", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const snapshots = [
    `${process.pid} 1 80000 now\n91001 ${process.pid} 91001 root\n91002 91001 91002 old\n91003 91001 91003 same\n`,
    `${process.pid} 1 80000 now\n91002 1 91002 reused\n91003 1 91003 same\n`,
  ];
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => { queueMicrotask(() => callback(null, snapshots.shift()!)); return {}; }) as unknown as typeof execFile);
  await terminateProcessTree(91001, { exited: Promise.resolve(), graceMs: 1 });
  expect(kill).toHaveBeenCalledWith(91003, "SIGKILL");
  expect(kill).not.toHaveBeenCalledWith(91002, "SIGKILL");
  expect(kill).not.toHaveBeenCalledWith(-91002, "SIGKILL");
});

it("uses asynchronous taskkill with descendant cleanup on Windows", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => { queueMicrotask(() => callback(null, "")); return {}; }) as unknown as typeof execFile);
    await killProcessTree(91001);
    expect(execFile).toHaveBeenCalledWith("taskkill.exe", ["/pid", "91001", "/t", "/f"], expect.objectContaining({ timeout: 1500, windowsHide: true }), expect.any(Function));
    expect(kill).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
