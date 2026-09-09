import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BrowserAutomation } from "./automation";
import type { WebContents } from "electron";

const contents = vi.hoisted(() => new Map<number, unknown>());
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => contents.get(id) },
  BrowserWindow: { fromWebContents: () => undefined },
}));

let nextGuestId = 1;

function fixture(owner: unknown) {
  const id = nextGuestId++;
  const guest = Object.assign(new EventEmitter(), {
    id,
    hostWebContents: owner,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.test",
    getTitle: () => "页面",
    debugger: {
      isAttached: () => true,
      sendCommand: vi.fn(async () => ({
        nodes: [
          { nodeId: "1", backendDOMNodeId: 1, role: { value: "button" }, name: { value: "提交" } },
        ],
      })),
    },
  });
  contents.set(id, guest);
  return { id, guest };
}

const owner = () =>
  Object.assign(new EventEmitter(), {
    getType: () => "window",
    isDestroyed: () => false,
    send: vi.fn(),
  }) as unknown as WebContents;

const value = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.content[0].text ?? "{}");

/** 让 show() 的 presentation 等待立即得到确认。 */
function autoConfirm(controller: BrowserAutomation, host: WebContents) {
  vi.mocked(host.send).mockImplementation((_channel: string, event: { requestId?: string }) => {
    if (event?.requestId) controller.presentationReady(host, event.requestId);
  });
}

/** 模拟浏览器面板：收到 open 消息后立即登记一个新标签。 */
function fakeWindow(controller: BrowserAutomation, host: WebContents) {
  let created = 0;
  return {
    isDestroyed: () => false,
    show: () => undefined,
    webContents: {
      send: (_channel: string, event: { action: string; instanceId: string }) => {
        if (event.action !== "open") return;
        created += 1;
        const guest = fixture(host);
        controller.register(host, {
          instanceId: event.instanceId,
          tabId: `auto-${created}`,
          webContentsId: guest.id,
        });
      },
    },
  } as unknown as Electron.BrowserWindow;
}

beforeEach(() => contents.clear());

describe("BrowserAutomation runtime isolation", () => {
  it("keeps one working tab per runtime and does not clear another runtime's refs", async () => {
    const host = owner();
    const first = fixture(host);
    const second = fixture(host);
    const controller = new BrowserAutomation(() => undefined);
    autoConfirm(controller, host);
    controller.register(host, { instanceId: "panel", tabId: "tab-a", webContentsId: first.id });
    controller.register(host, { instanceId: "panel", tabId: "tab-b", webContentsId: second.id });

    await controller.execute("browser_select_tab", { tabId: "tab-a" }, new AbortController().signal, "runtime-a");
    await controller.execute("browser_select_tab", { tabId: "tab-b" }, new AbortController().signal, "runtime-b");
    const refA = value(await controller.execute("browser_observe", { tabId: "tab-a" }, new AbortController().signal, "runtime-a")).elements[0].ref;

    controller.resetAgent("runtime-a");

    const listA = value(await controller.execute("browser_list_tabs", {}, new AbortController().signal, "runtime-a"));
    const listB = value(await controller.execute("browser_list_tabs", {}, new AbortController().signal, "runtime-b"));
    expect(listA.workingTabId).toBeNull();
    expect(listB.workingTabId).toBe("tab-b");
    expect(listA.tabs).toHaveLength(2);
    expect(listB.tabs).toHaveLength(2);
    expect(refA).toBeTruthy();
  });

  it("rejects a tab created by another runtime", async () => {
    const host = owner();
    const controller: BrowserAutomation = new BrowserAutomation(() => fakeWindow(controller, host));
    const created = value(await controller.execute("browser_new_tab", { url: "about:blank" }, new AbortController().signal, "runtime-a"));
    const tabId = created.tabId as string;

    await expect(
      controller.execute("browser_observe", { tabId }, new AbortController().signal, "runtime-b"),
    ).rejects.toThrow("属于其他 Agent 会话");
    // 归属方仍可正常操作。
    const observed = value(await controller.execute("browser_observe", { tabId }, new AbortController().signal, "runtime-a"));
    expect(observed.tabId).toBe(tabId);
  });

  it("caps the per-runtime operation queue", async () => {
    const host = owner();
    const guest = fixture(host);
    const controller = new BrowserAutomation(() => undefined);
    controller.register(host, { instanceId: "panel", tabId: "tab", webContentsId: guest.id });
    const signal = new AbortController().signal;
    const queued = Array.from({ length: 12 }, () =>
      controller.execute("browser_list_tabs", {}, signal, "runtime-a"),
    );
    const settled = await Promise.allSettled(queued);
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(rejected.length).toBe(4);
    expect(settled.filter((item) => item.status === "fulfilled").length).toBe(8);
    // 其他 runtime 的队列不受影响。
    await expect(
      controller.execute("browser_list_tabs", {}, signal, "runtime-b"),
    ).resolves.toBeTruthy();
  });

  it("removes tabs when their host window is destroyed", async () => {
    const host = owner();
    const guest = fixture(host);
    const controller = new BrowserAutomation(() => undefined);
    controller.register(host, { instanceId: "panel", tabId: "tab", webContentsId: guest.id });
    host.emit("destroyed");
    const result = value(await controller.execute("browser_list_tabs", {}, new AbortController().signal, "runtime-a"));
    expect(result.tabs).toEqual([]);
  });
});
