import { BrowserWindow, webContents, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { browserText, validateBrowserParams, type BrowserParams, type BrowserRegistration, type BrowserToolResult } from "../../shared/browser-tools";
import { normalizeUrl } from "../../renderer/browser/url";
import { BrowserRefs, type AXNode } from "./accessibility";
import { pageOperation } from "./page-operations";

interface Tab extends BrowserRegistration { guest: WebContents; owner: WebContents; refs: BrowserRefs }
type RemoteResult = { result: { objectId?: string; value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

function aborted(signal: AbortSignal) { if (signal.aborted) throw new Error("浏览器操作已取消或超时"); }
async function bounded<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs = 8000): Promise<T> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const done = (error?: unknown, value?: T) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => done(new Error("浏览器操作已取消或超时"));
    const timer = setTimeout(() => done(new Error("网页响应超时，请观察或重新加载页面；不要盲目重复提交。")), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => done(undefined, value), (error) => done(error));
  });
}

/** Owns only registered browser guests. All commands are serialized, including observations. */
export class BrowserAutomation {
  private tabs = new Map<string, Tab>();
  private workingTabId?: string;
  private presentations = new Map<string, { owner: WebContents; resolve: () => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly getMainWindow: () => BrowserWindow | undefined) {}

  resetAgent() { this.workingTabId = undefined; for (const tab of this.tabs.values()) tab.refs.clear(); }

  register(owner: WebContents, registration: BrowserRegistration) {
    if (!registration || typeof registration.tabId !== "string" || typeof registration.instanceId !== "string" || !registration.tabId || !registration.instanceId || !Number.isInteger(registration.webContentsId)) throw new Error("无效的浏览器标签登记");
    const guest = webContents.fromId(registration.webContentsId);
    if (owner.getType() !== "window" || !guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== owner) throw new Error("浏览器标签不属于请求窗口");
    const previous = this.tabs.get(registration.tabId);
    if (previous?.guest === guest) return;
    if (previous) throw new Error("浏览器标签 ID 已被使用");
    const tab = { ...registration, owner, guest, refs: new BrowserRefs() };
    this.tabs.set(tab.tabId, tab);
    const invalidate = () => tab.refs.clear();
    guest.on("did-start-navigation", invalidate);
    guest.on("render-process-gone", invalidate);
    guest.once("destroyed", () => this.remove(tab));
  }

  private remove(tab: Tab) {
    if (this.tabs.get(tab.tabId) !== tab) return;
    this.tabs.delete(tab.tabId);
    tab.refs.clear();
    if (this.workingTabId === tab.tabId) this.workingTabId = undefined;
  }

  execute(tool: string, params: BrowserParams, externalSignal: AbortSignal): Promise<BrowserToolResult> {
    validateBrowserParams(tool, params);
    const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(40000)]);
    const run = this.queue.catch(() => {}).then(() => { aborted(signal); return this.perform(tool, params, signal); });
    this.queue = run;
    return run;
  }

  private list() {
    for (const tab of this.tabs.values()) if (tab.guest.isDestroyed() || tab.owner.isDestroyed()) this.remove(tab);
    return [...this.tabs.values()].map((tab) => ({ tabId: tab.tabId, instanceId: tab.instanceId, url: tab.guest.getURL(), title: tab.guest.getTitle(), working: this.workingTabId === tab.tabId }));
  }

  private target(params: BrowserParams): Tab {
    this.list();
    const id = params.tabId as string | undefined ?? this.workingTabId;
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) throw new Error("没有可用的目标标签。请 browser_list_tabs 后 select_tab，或用 browser_navigate/browser_new_tab 打开页面。");
    return tab;
  }

  presentationReady(owner: WebContents, requestId: string) {
    const pending = this.presentations.get(requestId);
    if (pending?.owner === owner) pending.resolve();
  }

  private async show(tab: Tab, signal: AbortSignal) {
    const requestId = randomUUID();
    const ready = new Promise<void>((resolve) => this.presentations.set(requestId, { owner: tab.owner, resolve }));
    try {
      tab.owner.send("browser:agent-presentation", { action: "select", instanceId: tab.instanceId, tabId: tab.tabId, requestId });
      const win = BrowserWindow.fromWebContents(tab.owner);
      if (win && !win.isDestroyed()) win.show();
      await bounded(ready, signal, 5000);
    } finally { this.presentations.delete(requestId); }
  }

  private async create(url: string, signal: AbortSignal): Promise<Tab> {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) throw new Error("主窗口不可用，请重新打开 Tether");
    const instanceId = `agent-browser-${randomUUID()}`;
    win.webContents.send("browser:agent-presentation", { action: "open", instanceId, url: "about:blank" });
    win.show();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      aborted(signal);
      const tab = [...this.tabs.values()].find((item) => item.instanceId === instanceId);
      if (tab) {
        this.workingTabId = tab.tabId;
        if (url !== "about:blank") await this.navigate(tab, url, signal);
        return tab;
      }
      await delay(50, undefined, { signal });
    }
    throw new Error("浏览器面板未就绪。请确认已选项目且主窗口正常显示，再重试。");
  }

  private url(input: string): string {
    const url = normalizeUrl(input, "about:blank");
    if (url !== "about:blank" && !/^https?:\/\//i.test(url)) throw new Error("Agent 浏览器导航支持 http、https 和 about:blank。本地服务请使用 http://localhost:端口。");
    return url;
  }

  private async cdp<T = Record<string, unknown>>(tab: Tab, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    aborted(signal);
    if (tab.guest.isDestroyed()) throw new Error("浏览器标签已关闭，请重新列出标签");
    if (!tab.guest.debugger.isAttached()) tab.guest.debugger.attach("1.3");
    return bounded(tab.guest.debugger.sendCommand(method, params) as Promise<T>, signal);
  }

  private unwrap(response: RemoteResult) {
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "页面操作失败");
    return response.result;
  }

  private async page(tab: Tab, args: BrowserParams, signal: AbortSignal): Promise<unknown> {
    const result = await this.cdp<RemoteResult>(tab, "Runtime.evaluate", { expression: `(${pageOperation.toString()}).call(undefined, ${JSON.stringify(args)})`, returnByValue: true }, signal);
    return this.unwrap(result).value;
  }

  private async node(tab: Tab, params: BrowserParams, signal: AbortSignal): Promise<string> {
    let result: RemoteResult;
    if (params.ref) {
      const backendNodeId = tab.refs.resolve(params.ref as string);
      try {
        const resolved = await this.cdp<{ object: { objectId?: string } }>(tab, "DOM.resolveNode", { backendNodeId }, signal);
        if (!resolved.object.objectId) throw new Error("missing node");
        return resolved.object.objectId;
      } catch { throw new Error("元素 ref 已失效，请重新 browser_observe 获取元素后再操作"); }
    }
    result = await this.cdp<RemoteResult>(tab, "Runtime.evaluate", { expression: `(${pageOperation.toString()}).call(undefined, ${JSON.stringify({ action: "resolve", selector: params.selector })})` }, signal);
    const objectId = this.unwrap(result).objectId;
    if (!objectId) throw new Error("未能定位网页元素");
    return objectId;
  }

  private async element(tab: Tab, params: BrowserParams, action: string, signal: AbortSignal): Promise<unknown> {
    const revision = tab.refs.revision;
    const assertCurrent = () => {
      aborted(signal);
      if (revision !== tab.refs.revision) throw new Error("页面在操作期间发生导航，请重新观察后操作");
    };
    const objectId = await this.node(tab, params, signal);
    assertCurrent();
    const call = async (operation: string) => this.unwrap(await this.cdp<RemoteResult>(tab, "Runtime.callFunctionOn", { objectId, functionDeclaration: pageOperation.toString(), arguments: [{ value: { ...params, action: operation } }], returnByValue: true, userGesture: true }, signal)).value;
    try {
      if (action === "click" || action === "hover") {
        let point = await call("point") as { x: number; y: number };
        let stable = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          assertCurrent();
          await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, signal);
          // mouseenter can replace the target or alter layout. Recheck the same node and
          // use exactly the visible, hit-tested point returned by the page operation.
          const next = await call("point") as { x: number; y: number };
          if (Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5) { stable = true; break; }
          point = next;
        }
        if (!stable) throw new Error("目标在悬浮后持续移动，请重新观察页面再操作");
        if (action === "click") {
          assertCurrent();
          let released = false;
          try {
            await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, signal);
            await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, signal);
            released = true;
          } finally {
            if (!released) await this.releaseInput(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", x: -1, y: -1, button: "left", clickCount: 1 });
          }
        }
        return { dispatched: true, action };
      }
      assertCurrent();
      const result = await call(action) as { insertText?: boolean };
      if (result?.insertText) {
        assertCurrent();
        await this.cdp(tab, "Input.insertText", { text: params.text }, signal);
        return { filled: true, characters: (params.text as string).length };
      }
      return result;
    } finally {
      if (!tab.guest.isDestroyed() && tab.guest.debugger.isAttached()) void tab.guest.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  private async navigate(tab: Tab, url: string, signal: AbortSignal) {
    tab.refs.clear();
    await this.show(tab, signal);
    // CDP Page.navigate acknowledges navigation without waiting for all subresources/streaming requests.
    const result = await this.cdp<{ errorText?: string; loaderId?: string }>(tab, "Page.navigate", { url }, signal);
    if (result.errorText) throw new Error(`网页导航失败：${result.errorText}`);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      aborted(signal);
      try {
        const { frameTree } = await this.cdp<{ frameTree: { frame: { loaderId?: string } } }>(tab, "Page.getFrameTree", {}, signal);
        // The old document can still be "complete" while the new response is pending.
        if ((!result.loaderId || frameTree.frame.loaderId === result.loaderId) && await this.page(tab, { action: "ready" }, signal)) return;
      } catch { aborted(signal); }
      await delay(100, undefined, { signal });
    }
    throw new Error("页面仍在加载，请 browser_observe 检查当前状态后继续。");
  }

  private async observe(tab: Tab, params: BrowserParams, signal: AbortSignal) {
    tab.refs.clear();
    const revision = tab.refs.revision;
    const { nodes } = await this.cdp<{ nodes: AXNode[] }>(tab, "Accessibility.getFullAXTree", {}, signal);
    if (revision !== tab.refs.revision) throw new Error("观察期间页面发生导航，请重新 browser_observe");
    return { tabId: tab.tabId, url: tab.guest.getURL(), title: tab.guest.getTitle(), ...tab.refs.snapshot(nodes, params), untrusted: true };
  }

  private async wait(tab: Tab, params: BrowserParams, signal: AbortSignal) {
    const deadline = Date.now() + ((params.timeoutMs as number | undefined) ?? 10000);
    do {
      aborted(signal);
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
      try {
        if (await this.page(tab, { ...params, action: "wait" }, probeSignal)) return { matched: true };
      } catch (error) {
        aborted(signal);
        if (probeSignal.aborted) break;
        if (!/context|navigat|frame/i.test(String(error))) throw error;
      }
      await delay(100, undefined, { signal });
    } while (Date.now() < deadline);
    return { matched: false, hint: "条件未在期限内出现，请观察页面确认实际结果，避免重复提交。" };
  }

  /** Release possibly held inputs even after cancellation, without reattaching or replaying a press. */
  private async releaseInput(tab: Tab, method: string, params: Record<string, unknown>) {
    if (tab.guest.isDestroyed() || !tab.guest.debugger.isAttached()) return;
    await bounded(tab.guest.debugger.sendCommand(method, params), AbortSignal.timeout(1000), 1000).catch(() => {});
  }

  private async press(tab: Tab, key: string, signal: AbortSignal) {
    const named: Record<string, [string, number]> = { Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39], Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: [" ", 32] };
    const selectAll = /^(Control|Ctrl|Meta|Cmd)\+a$/i.test(key);
    if (selectAll || named[key]) {
      const [value, code] = selectAll ? ["a", 65] : named[key];
      const release = { type: "keyUp", key: value, windowsVirtualKeyCode: code };
      let released = false;
      try {
        await this.cdp(tab, "Input.dispatchKeyEvent", {
          type: selectAll ? "rawKeyDown" : "keyDown", key: value, windowsVirtualKeyCode: code,
          ...(selectAll ? { code: "KeyA", modifiers: /Meta|Cmd/i.test(key) ? 4 : 2, commands: ["selectAll"] } :
            key === "Enter" ? { text: "\r" } : key === "Space" ? { text: " " } : {}),
        }, signal);
        await this.cdp(tab, "Input.dispatchKeyEvent", release, signal);
        released = true;
      } finally {
        if (!released) await this.releaseInput(tab, "Input.dispatchKeyEvent", release);
      }
    } else await this.cdp(tab, "Input.insertText", { text: key }, signal);
    return { dispatched: true };
  }

  private async perform(tool: string, params: BrowserParams, signal: AbortSignal): Promise<BrowserToolResult> {
    if (tool === "browser_list_tabs") return browserText({ tabs: this.list(), workingTabId: this.workingTabId ?? null });
    if (tool === "browser_new_tab" || (tool === "browser_navigate" && !params.tabId && !this.workingTabId)) {
      const tab = await this.create(this.url(params.url as string | undefined ?? "about:blank"), signal);
      return browserText(await this.observe(tab, {}, signal));
    }
    const tab = this.target(params);
    if (tool === "browser_select_tab") { this.workingTabId = tab.tabId; await this.show(tab, signal); return browserText(await this.observe(tab, {}, signal)); }
    if (tool === "browser_close_tab") {
      tab.owner.send("browser:agent-presentation", { action: "close", instanceId: tab.instanceId, tabId: tab.tabId });
      const deadline = Date.now() + 5000;
      while (!tab.guest.isDestroyed() && Date.now() < deadline) await delay(50, undefined, { signal });
      if (!tab.guest.isDestroyed()) throw new Error("标签关闭尚未确认，请列出标签检查状态");
      this.remove(tab);
      return browserText({ closed: true, tabId: tab.tabId });
    }
    if (tool === "browser_navigate") { await this.navigate(tab, this.url(params.url as string), signal); return browserText(await this.observe(tab, {}, signal)); }
    if (tool === "browser_observe" || tool === "browser_find") return browserText(await this.observe(tab, params, signal));
    let result: unknown;
    if (["browser_click", "browser_fill", "browser_hover", "browser_dom", "browser_select_option", "browser_press", "browser_scroll", "browser_screenshot"].includes(tool)) await this.show(tab, signal);
    switch (tool) {
      case "browser_click":
        result = await this.element(tab, params, "click", signal);
        if (params.waitKind) result = { ...(result as object), ...await this.wait(tab, { kind: params.waitKind, value: params.waitValue, timeoutMs: params.timeoutMs }, signal) };
        break;
      case "browser_fill": result = await this.element(tab, params, "fill", signal); break;
      case "browser_hover": result = await this.element(tab, params, "hover", signal); break;
      case "browser_select_option": result = await this.element(tab, params, "select", signal); break;
      case "browser_dom": result = await this.element(tab, params, params.action as string, signal); break;
      case "browser_press": result = await this.press(tab, params.key as string, signal); break;
      case "browser_wait_for": result = await this.wait(tab, params, signal); break;
      case "browser_extract": result = await this.page(tab, { ...params, action: "extract" }, signal); break;
      case "browser_scroll": result = await this.page(tab, { ...params, action: "scroll" }, signal); break;
      case "browser_screenshot": {
        const image = await bounded(tab.guest.capturePage(), signal);
        return { content: [{ type: "text", text: JSON.stringify({ tabId: tab.tabId, url: tab.guest.getURL() }) }, { type: "image", data: image.toPNG().toString("base64"), mimeType: "image/png" }] };
      }
      default: throw new Error("不支持的浏览器工具");
    }
    return browserText({ tabId: tab.tabId, url: tab.guest.isDestroyed() ? "" : tab.guest.getURL(), result, hint: "用 browser_observe/browser_extract 验证页面结果。", untrusted: true });
  }
}
