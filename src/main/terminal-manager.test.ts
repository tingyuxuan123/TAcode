import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "./terminal-manager";

describe("TerminalManager", () => {
  let root = "";
  let manager: TerminalManager | undefined;

  afterEach(async () => {
    manager?.stopAll();
    manager = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("starts a shell, forwards output, and reports exit", async () => {
    root = await mkdtemp(join(tmpdir(), "tacode-terminal-"));
    const events: Array<{ id: string; type: string; data?: string; exitCode?: number | null }> = [];
    manager = new TerminalManager((event) => events.push(event));
    const info = manager.start(root);
    const command = process.platform === "win32"
      ? "echo TACODE_TERMINAL_TEST\r\nexit\r\n"
      : "printf 'TACODE_TERMINAL_TEST\\n'; exit\n";
    manager.write(info.id, command);
    await vi.waitFor(() => expect(events.some((event) => event.type === "exit" && event.id === info.id)).toBe(true), { timeout: 5_000 });
    expect(events.filter((event) => event.id === info.id).map((event) => event.data).join("")).toContain("TACODE_TERMINAL_TEST");
    expect(manager.list().find((item) => item.id === info.id)).toMatchObject({ running: false });
  }, 10_000);

  it("rejects unknown sessions and oversized input", async () => {
    root = await mkdtemp(join(tmpdir(), "tacode-terminal-"));
    const current = new TerminalManager(() => {});
    manager = current;
    expect(() => current.write("missing", "pwd\n")).toThrow("Unknown terminal session");
    const info = current.start(root);
    expect(() => current.write(info.id, "x".repeat(32_001))).toThrow("too long");
  }, 10_000);
});
