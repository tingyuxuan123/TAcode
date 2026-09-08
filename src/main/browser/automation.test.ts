import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BrowserAutomation } from "./automation";
import type { WebContents } from "electron";

const contents = vi.hoisted(() => new Map<number, unknown>());
vi.mock("electron", () => ({ webContents: { fromId: (id: number) => contents.get(id) }, BrowserWindow: { fromWebContents: () => undefined } }));

function fixture(id: number, owner: unknown) {
  const guest = Object.assign(new EventEmitter(), {
    id, hostWebContents: owner, isDestroyed: () => false, getType: () => "webview", getURL: () => "https://example.test", getTitle: () => "页面",
    debugger: { isAttached: () => true, sendCommand: vi.fn<(...args: any[]) => Promise<any>>(async () => ({ nodes: [{ nodeId: "1", backendDOMNodeId: 1, role: { value: "button" }, name: { value: "提交" } }] })) },
  });
  contents.set(id, guest);
  return guest;
}
const owner = () => ({ getType: () => "window", isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents;
const value = (result: { content: any[] }) => JSON.parse(result.content[0].text);
beforeEach(() => contents.clear());

describe("browser guest routing and lifecycle", () => {
  it("rejects registration by a different window", () => {
    const host = owner();
    fixture(1, host);
    const controller = new BrowserAutomation(() => undefined);
    expect(() => controller.register(owner(), { instanceId: "panel", tabId: "tab", webContentsId: 1 })).toThrow("不属于");
    controller.register(host, { instanceId: "panel", tabId: "tab", webContentsId: 1 });
  });
  it("discards an AX snapshot if the page navigated while CDP was reading it", async () => {
    const host = owner();
    const guest = fixture(1, host);
    const controller = new BrowserAutomation(() => undefined);
    controller.register(host, { instanceId: "panel", tabId: "tab", webContentsId: 1 });
    guest.debugger.sendCommand.mockImplementationOnce(async () => {
      guest.emit("did-start-navigation");
      return { nodes: [] };
    });
    await expect(controller.execute("browser_observe", { tabId: "tab" }, new AbortController().signal)).rejects.toThrow("观察期间页面发生导航");
    const result = value(await controller.execute("browser_observe", { tabId: "tab" }, new AbortController().signal));
    expect(result.elements[0].name).toBe("提交");
  });
  it("cleans up destroyed tabs and does not silently redirect their commands", async () => {
    const host = owner();
    const first = fixture(1, host);
    fixture(2, host);
    const controller = new BrowserAutomation(() => undefined);
    controller.register(host, { instanceId: "panel", tabId: "first", webContentsId: 1 });
    controller.register(host, { instanceId: "panel", tabId: "second", webContentsId: 2 });
    first.emit("destroyed");
    const result = value(await controller.execute("browser_list_tabs", {}, new AbortController().signal));
    expect(result.tabs.map((tab: { tabId: string }) => tab.tabId)).toEqual(["second"]);
    await expect(controller.execute("browser_observe", { tabId: "first" }, new AbortController().signal)).rejects.toThrow("没有可用的目标标签");
  });
  it("only accepts presentation acknowledgement from the target host", async () => {
    const host = owner();
    fixture(1, host);
    const controller = new BrowserAutomation(() => undefined);
    controller.register(host, { instanceId: "panel", tabId: "tab", webContentsId: 1 });
    let requestId = "";
    vi.mocked(host.send).mockImplementation((_channel: string, event: any) => { requestId = event.requestId; });
    let completed = false;
    const pending = controller.execute("browser_select_tab", { tabId: "tab" }, new AbortController().signal).then(() => { completed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestId).not.toBe("");
    controller.presentationReady(owner(), requestId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    controller.presentationReady(host, requestId);
    await pending;
    expect(completed).toBe(true);
  });
});


it.each(["mouse", "key"])("releases %s input when cancellation arrives after a press", async (kind) => {
  const host = owner();
  const guest = fixture(1, host);
  const automation = new BrowserAutomation(() => undefined);
  automation.register(host, { instanceId: "panel", tabId: "tab", webContentsId: 1 });
  vi.mocked(host.send).mockImplementation((_channel: string, event: any) => automation.presentationReady(host, event.requestId));
  const controller = new AbortController();
  const ref = value(await automation.execute("browser_observe", { tabId: "tab" }, controller.signal)).elements[0].ref;
  guest.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "target" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { x: 100, y: 100 } } };
    if (params?.type === "mousePressed" || params?.type === "keyDown") controller.abort();
    return {};
  });
  await expect(automation.execute(kind === "mouse" ? "browser_click" : "browser_press", kind === "mouse" ? { tabId: "tab", ref } : { tabId: "tab", key: "Enter" }, controller.signal)).rejects.toThrow("取消");
  expect(guest.debugger.sendCommand.mock.calls.some(([, params]) => params?.type === (kind === "mouse" ? "mouseReleased" : "keyUp"))).toBe(true);
});

it("does not click through a target replaced by mouseenter", async () => {
  const host = owner();
  const guest = fixture(1, host);
  const automation = new BrowserAutomation(() => undefined);
  automation.register(host, { instanceId: "panel", tabId: "tab", webContentsId: 1 });
  vi.mocked(host.send).mockImplementation((_channel: string, event: any) => automation.presentationReady(host, event.requestId));
  const signal = new AbortController().signal;
  const ref = value(await automation.execute("browser_observe", { tabId: "tab" }, signal)).elements[0].ref;
  let replaced = false;
  guest.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "target" } };
    if (method === "Runtime.callFunctionOn") return replaced ? { exceptionDetails: { text: "元素已被替换" } } : { result: { value: { x: 100, y: 100 } } };
    if (params?.type === "mouseMoved") replaced = true;
    return {};
  });
  await expect(automation.execute("browser_click", { tabId: "tab", ref }, signal)).rejects.toThrow("替换");
  expect(guest.debugger.sendCommand.mock.calls.some(([, params]) => params?.type === "mousePressed")).toBe(false);
});
