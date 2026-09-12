import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager, type PtyModule, type PtyTerminal } from "./terminal-manager";

interface FakeTerminal extends PtyTerminal {
  lastWrite: string;
  lastResize: [number, number] | undefined;
  killed: boolean;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

/** node-pty 是按 Electron ABI 编译的原生模块，在 Node 测试进程里不可加载：注入假实现。 */
function createFakePty() {
  const spawned: FakeTerminal[] = [];
  const module: PtyModule = {
    spawn: (_file, _args, _options) => {
      const listeners: {
        data?: (data: string) => void;
        exit?: (event: { exitCode: number; signal?: number }) => void;
      } = {};
      const terminal: FakeTerminal = {
        pid: 42_000 + spawned.length,
        write: (data) => {
          terminal.lastWrite = data;
        },
        resize: (columns, rows) => {
          terminal.lastResize = [columns, rows];
        },
        kill: () => {
          terminal.killed = true;
        },
        onData: (listener) => {
          listeners.data = listener;
        },
        onExit: (listener) => {
          listeners.exit = listener;
        },
        emitData: (data) => listeners.data?.(data),
        emitExit: (exitCode) => listeners.exit?.({ exitCode }),
        lastWrite: "",
        lastResize: undefined,
        killed: false,
      };
      spawned.push(terminal);
      return terminal;
    },
  };
  return { module, spawned };
}

describe("TerminalManager", () => {
  const cwd = "/tacode-fake-cwd";
  let manager: TerminalManager | undefined;
  let pty: ReturnType<typeof createFakePty> | undefined;

  afterEach(async () => {
    manager?.stopAll();
    manager = undefined;
    pty = undefined;
  });

  const boot = () => {
    pty = createFakePty();
    const events: Array<{ id: string; type: string; data?: string; exitCode?: number | null }> = [];
    manager = new TerminalManager((event) => events.push(event), () => pty!.module);
    return { events };
  };

  it("在 PTY 里启动 shell，输出与输入双向转发", () => {
    const { events } = boot();
    const info = manager!.start(cwd);
    expect(info).toMatchObject({ running: true, shell: expect.any(String), cwd });
    const terminal = pty!.spawned[0];
    terminal.emitData("hello\r\n");
    expect(events.some((event) => event.type === "output" && event.data === "hello\r\n")).toBe(true);
    manager!.write(info.id, "pwd\n");
    expect(terminal.lastWrite).toBe("pwd\n");
    terminal.emitExit(0);
    expect(events.some((event) => event.type === "exit" && event.exitCode === 0)).toBe(true);
    expect(manager!.list().find((item) => item.id === info.id)).toMatchObject({ running: false });
  });

  it("resize 校验范围并转发给 PTY", () => {
    boot();
    const info = manager!.start(cwd);
    const terminal = pty!.spawned[0];
    manager!.resize(info.id, 120, 40);
    expect(terminal.lastResize).toEqual([120, 40]);
    expect(() => manager!.resize(info.id, 1, 40)).toThrow("out of range");
    expect(() => manager!.resize(info.id, 120, 501)).toThrow("out of range");
  });

  it("拒绝未知会话和超长输入，stop/stopAll 清理会话", () => {
    boot();
    manager!.start(cwd);
    expect(() => manager!.write("missing", "pwd\n")).toThrow("Unknown terminal session");
    const info = manager!.start(cwd);
    expect(() => manager!.write(info.id, "x".repeat(32_001))).toThrow("too long");
    const terminal = pty!.spawned[1];
    manager!.stop(info.id);
    expect(terminal.killed).toBe(true);
    const second = manager!.start(cwd);
    manager!.stopAll();
    expect(pty!.spawned[2].killed).toBe(true);
    expect(manager!.list().find((item) => item.id === second.id)).toBeUndefined();
  });

  it("停止后写入会报会话不在运行", () => {
    boot();
    const info = manager!.start(cwd);
    manager!.stop(info.id);
    // stop 里同步标记 running=false：PTY 的 exit 事件是异步到达的，UI 不依赖它才知道已停止。
    expect(() => manager!.write(info.id, "ls\n")).toThrow("not running");
  });

  it("node-pty 加载失败时报可读错误", () => {
    const events: Array<{ id: string; type: string }> = [];
    manager = new TerminalManager((event) => events.push(event), () => {
      throw new Error("cannot find module");
    });
    expect(() => manager!.start(cwd)).toThrow("node-pty");
  });
});
