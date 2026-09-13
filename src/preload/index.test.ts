import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../shared/types";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("electron", () => electron);

let api: DesktopApi;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  electron.ipcRenderer.invoke.mockResolvedValue({});
  await import("./index");
  api = electron.contextBridge.exposeInMainWorld.mock.calls[0][1] as DesktopApi;
});

describe("conversation routing", () => {
  it("does not restore default routing after a late start completes on a blank page", async () => {
    let finish!: (value: unknown) => void;
    electron.ipcRenderer.invoke.mockImplementation((channel) => channel === "agent:start"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    const starting = api.agent.start({ cwd: "/a", provider: "openai", permission: "ask", sandbox: "read-only" });
    await api.agent.deactivate();
    finish({ runtimeId: "a" });
    await starting;
    await api.agent.command("get_state");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("agent:command", "get_state", undefined, undefined);
  });

  it("keeps B selected after A completes late and targets background stop/replies explicitly", async () => {
    let finish!: (value: unknown) => void;
    electron.ipcRenderer.invoke.mockImplementation((channel, options) => channel === "agent:start"
      ? options.cwd === "/a" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ runtimeId: "b" })
      : Promise.resolve({}));
    const starting = api.agent.start({ cwd: "/a", provider: "openai", permission: "ask", sandbox: "read-only" });
    await api.agent.start({ cwd: "/b", provider: "openai", permission: "ask", sandbox: "read-only" });
    finish({ runtimeId: "a" });
    await starting;
    await api.agent.respondToUi("approval", { confirmed: true }, "a");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("agent:ui-response", "approval", { confirmed: true }, "a");
    await api.agent.stop("a");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("agent:stop", "a");
    await api.agent.command("get_state");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("agent:command", "get_state", undefined, "b");
  });
});
