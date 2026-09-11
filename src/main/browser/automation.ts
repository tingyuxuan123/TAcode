import { BrowserWindow, webContents, type WebContents } from "electron";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { browserText, normalizeBrowserParams, type BrowserParams, type BrowserRegistration, type BrowserToolResult } from "../../shared/browser-tools";
import { normalizeUrl } from "../../renderer/browser/url";
import { BrowserRefs, type AXNode } from "./accessibility";
import { pageOperation } from "./page-operations";
import { resolveWorkspacePreview, type WorkspacePreviewTarget } from "./preview-target";

interface Tab extends BrowserRegistration { guest: WebContents; owner: WebContents; refs: BrowserRefs; ownerRuntimeId?: string }
type RemoteResult = { result: { objectId?: string; value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

/** 单个 Agent 运行句柄的浏览器状态；工作标签与操作队列按它隔离。 */
interface AgentSession {
  runtimeId?: string;
  workingTabId?: string;
  queue: Promise<unknown>;
  queued: number;
}

/** 同一会话排队等待的浏览器操作上限，防止异常输入把内存撑爆。 */
const MAX_QUEUED_OPERATIONS = 8;
/** 同时监听的预览目录上限；超出后先放过最旧的，避免无限堆积 fs.watch。 */
const MAX_PREVIEW_WATCHES = 6;
/** 预览文件变更的防抖间隔，与 PI-Desktop 的 live reload 取值一致。 */
const PREVIEW_RELOAD_DEBOUNCE_MS = 250;

/** 正在监听的本地预览文件；文件或其同目录资源变更时刷新对应 guest。 */
interface PreviewWatch { watcher: FSWatcher; timer?: NodeJS.Timeout; file: string }

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

/** Owns only registered browser guests. Commands are serialized per Agent runtime. */
export class BrowserAutomation {
  private tabs = new Map<string, Tab>();
  /** 每个 Agent 运行句柄一份工作标签与操作队列，互不干扰。 */
  private sessions = new Map<string, AgentSession>();
  private presentations = new Map<string, { owner: WebContents; resolve: () => void }>();
  /** 每个宿主窗口只注册一次销毁清理，避免多标签重复挂监听。 */
  private watchedOwners = new WeakSet<WebContents>();
  /** tabId → 正在监听的本地预览文件（PI-Desktop live reload 的等价实现）。 */
  private previewWatches = new Map<string, PreviewWatch>();
  constructor(
    private readonly getMainWindow: () => BrowserWindow | undefined,
    /** 当前会话的工作区根：用于把工作区文件解析成内置浏览器可加载的预览 URL。 */
    private readonly getWorkspaceRoot?: () => string | undefined,
  ) {}

  private session(runtimeId?: string): AgentSession {
    const key = runtimeId || "default";
    let session = this.sessions.get(key);
    if (!session) {
      session = { ...(runtimeId ? { runtimeId } : {}), queue: Promise.resolve(), queued: 0 };
      this.sessions.set(key, session);
    }
    return session;
  }

  /** 只清理该 runtime 的工作标签与页面引用；其他 Agent 的页面不受影响。
   * 不传 runtimeId 时（兼容旧调用）清空全部。 */
  resetAgent(runtimeId?: string) {
    if (runtimeId === undefined) {
      for (const session of this.sessions.values()) session.workingTabId = undefined;
      for (const tab of this.tabs.values()) tab.refs.clear();
      for (const tabId of [...this.previewWatches.keys()]) this.stopPreviewWatch(tabId);
      return;
    }
    const session = this.sessions.get(runtimeId);
    if (session) session.workingTabId = undefined;
    for (const tab of this.tabs.values())
      if (tab.ownerRuntimeId === runtimeId) {
        tab.refs.clear();
        this.stopPreviewWatch(tab.tabId);
      }
  }

  register(owner: WebContents, registration: BrowserRegistration) {
    if (!registration || typeof registration.tabId !== "string" || typeof registration.instanceId !== "string" || !registration.tabId || !registration.instanceId || !Number.isInteger(registration.webContentsId)) throw new Error("无效的浏览器标签登记");
    const guest = webContents.fromId(registration.webContentsId);
    if (owner.getType() !== "window" || !guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== owner) throw new Error("浏览器标签不属于请求窗口");
    const previous = this.tabs.get(registration.tabId);
    if (previous?.guest === guest) return;
    if (previous) throw new Error("浏览器标签 ID 已被使用");
    const tab: Tab = { ...registration, owner, guest, refs: new BrowserRefs() };
    this.tabs.set(tab.tabId, tab);
    const invalidate = () => tab.refs.clear();
    guest.on("did-start-navigation", invalidate);
    guest.on("render-process-gone", invalidate);
    guest.once("destroyed", () => this.remove(tab));
    if (!this.watchedOwners.has(owner)) {
      this.watchedOwners.add(owner);
      // WebContents 在真实运行时是 EventEmitter；测试替身可能没有事件接口。
      if (typeof owner.once === "function")
        owner.once("destroyed", () => this.cleanupOwner(owner));
    }
  }

  private remove(tab: Tab) {
    if (this.tabs.get(tab.tabId) !== tab) return;
    this.stopPreviewWatch(tab.tabId);
    this.tabs.delete(tab.tabId);
    tab.refs.clear();
    for (const session of this.sessions.values())
      if (session.workingTabId === tab.tabId) session.workingTabId = undefined;
  }

  /** 宿主窗口销毁：移除它的标签映射与未完成的 presentation 等待，避免残留引用。 */
  private cleanupOwner(owner: WebContents) {
    for (const tab of [...this.tabs.values()])
      if (tab.owner === owner) this.remove(tab);
    for (const [requestId, pending] of this.presentations)
      if (pending.owner === owner) this.presentations.delete(requestId);
  }

  /** 预览文件变更后刷新对应 guest（对齐 PI-Desktop 的 live reload）。 */
  private watchPreview(tab: Tab, file: string) {
    this.stopPreviewWatch(tab.tabId);
    let watcher: FSWatcher;
    try {
      watcher = watch(path.dirname(file), { persistent: false });
    } catch {
      return;
    }
    const entry: PreviewWatch = { watcher, file };
    watcher.on("change", () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        const current = this.tabs.get(tab.tabId);
        if (current !== tab || tab.guest.isDestroyed()) return;
        // 页面重载后旧 ref 全部失效，与导航保持一致。
        tab.refs.clear();
        tab.guest.reload();
      }, PREVIEW_RELOAD_DEBOUNCE_MS);
    });
    watcher.on("error", () => this.stopPreviewWatch(tab.tabId));
    this.previewWatches.set(tab.tabId, entry);
    if (this.previewWatches.size > MAX_PREVIEW_WATCHES)
      for (const tabId of this.previewWatches.keys())
        if (tabId !== tab.tabId) { this.stopPreviewWatch(tabId); break; }
  }

  private stopPreviewWatch(tabId: string) {
    const entry = this.previewWatches.get(tabId);
    if (!entry) return;
    this.previewWatches.delete(tabId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
  }

  execute(tool: string, params: BrowserParams, externalSignal: AbortSignal, runtimeId?: string): Promise<BrowserToolResult> {
    // 模型可能把可选参数填成空串（如 tabId:""）；归一化后按“未提供”处理，避免整次调用失败。
    const input = normalizeBrowserParams(tool, params);
    const session = this.session(runtimeId);
    if (session.queued >= MAX_QUEUED_OPERATIONS) return Promise.reject(new Error("浏览器操作排队过多，请等待当前操作结束后重试。"));
    const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(40000)]);
    session.queued += 1;
    const run = session.queue.catch(() => {}).then(() => {
      session.queued = Math.max(0, session.queued - 1);
      aborted(signal);
      return this.perform(tool, input, signal, session);
    });
    session.queue = run.catch(() => undefined);
    return run;
  }

  private list(session?: AgentSession) {
    for (const tab of [...this.tabs.values()]) if (tab.guest.isDestroyed() || tab.owner.isDestroyed()) this.remove(tab);
    return [...this.tabs.values()].map((tab) => ({ tabId: tab.tabId, instanceId: tab.instanceId, url: tab.guest.getURL(), title: tab.guest.getTitle(), working: session?.workingTabId === tab.tabId }));
  }

  private target(params: BrowserParams, session: AgentSession): Tab {
    this.list(session);
    const explicit = params.tabId as string | undefined;
    const id = explicit ?? session.workingTabId;
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) throw new Error("没有可用的目标标签。请 browser_list_tabs 后 select_tab，或用 browser_navigate/browser_new_tab 打开页面。");
    // 归属校验：显式指定的标签必须属于本会话，或是用户自己打开（无归属）的标签。
    if (explicit && tab.ownerRuntimeId && tab.ownerRuntimeId !== session.runtimeId)
      throw new Error("该浏览器标签属于其他 Agent 会话，请用 browser_list_tabs 重新选择。");
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

  private async create(target: { url: string; preview?: WorkspacePreviewTarget }, signal: AbortSignal, session: AgentSession): Promise<Tab> {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) throw new Error("主窗口不可用，请重新打开 TACode");
    const instanceId = `agent-browser-${randomUUID()}`;
    win.webContents.send("browser:agent-presentation", { action: "open", instanceId, url: "about:blank" });
    win.show();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      aborted(signal);
      const tab = [...this.tabs.values()].find((item) => item.instanceId === instanceId);
      if (tab) {
        tab.ownerRuntimeId = session.runtimeId;
        session.workingTabId = tab.tabId;
        if (target.url !== "about:blank") await this.navigate(tab, target.url, signal, target.preview);
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

  /** 工作区文件路径 → harness-preview 预览 URL；其余输入仍按普通 URL 处理。 */
  private destination(params: BrowserParams): { url: string; preview?: WorkspacePreviewTarget } {
    const pathParam = typeof params.path === "string" ? params.path : undefined;
    const urlParam = typeof params.url === "string" ? params.url : undefined;
    const preview = resolveWorkspacePreview(pathParam ?? urlParam, this.getWorkspaceRoot?.(), { explicit: pathParam !== undefined });
    if (preview) return { url: preview.url, preview };
    if (pathParam !== undefined)
      throw new Error("未找到该工作区文件。path 必须是项目内已存在的文件（相对项目根，如 demo/index.html，或绝对路径）。");
    return { url: this.url(urlParam ?? "about:blank") };
  }

  private async navigate(tab: Tab, url: string, signal: AbortSignal, preview?: WorkspacePreviewTarget) {
    tab.refs.clear();
    if (preview) this.watchPreview(tab, preview.file);
    else this.stopPreviewWatch(tab.tabId);
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

  private async perform(tool: string, params: BrowserParams, signal: AbortSignal, session: AgentSession): Promise<BrowserToolResult> {
    if (tool === "browser_list_tabs") return browserText({ tabs: this.list(session), workingTabId: session.workingTabId ?? null });
    if (tool === "browser_new_tab" || (tool === "browser_navigate" && !params.tabId && !session.workingTabId)) {
      const tab = await this.create(this.destination(params), signal, session);
      return browserText(await this.observe(tab, {}, signal));
    }
    const tab = this.target(params, session);
    if (tool === "browser_select_tab") { session.workingTabId = tab.tabId; await this.show(tab, signal); return browserText(await this.observe(tab, {}, signal)); }
    if (tool === "browser_close_tab") {
      tab.owner.send("browser:agent-presentation", { action: "close", instanceId: tab.instanceId, tabId: tab.tabId });
      const deadline = Date.now() + 5000;
      while (!tab.guest.isDestroyed() && Date.now() < deadline) await delay(50, undefined, { signal });
      if (!tab.guest.isDestroyed()) throw new Error("标签关闭尚未确认，请列出标签检查状态");
      this.remove(tab);
      return browserText({ closed: true, tabId: tab.tabId });
    }
    if (tool === "browser_navigate") {
      const target = this.destination(params);
      await this.navigate(tab, target.url, signal, target.preview);
      return browserText(await this.observe(tab, {}, signal));
    }
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
