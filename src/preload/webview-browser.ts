import { ipcRenderer } from "electron";

/**
 * 内置浏览器 webview 的 guest preload。
 *
 * 移植自 Snow App（MIT）src/preload/webviewBrowserPreload.ts（Layer A 部分：
 * 链接拦截中继；密码助手在凭据层单独加入）。
 *
 * 运行在 guest 页面上下文中（`<webview webpreferences="sandbox=no">`），
 * 用于绕过 Electron 长期未修复的 bug（electron#30886）：webview 内点击
 * target="_blank" 链接既不触发 setWindowOpenHandler 也不创建窗口（表现为
 * 点击无效），而 JS window.open() 调用可正常触发 handler。
 *
 * 在 guest 侧以捕获阶段拦截链接激活（早于页面自身点击逻辑），改经主进程
 * 中继（browserPopupWindow 校验后转发宿主窗口），复用 browser:open-tab
 * 链路在浏览器面板内新建标签页：
 *   - 左键点击 <a target="_blank">（含 <base target> 生效场景）→ 前台标签页
 *   - 中键 / Ctrl(⌘)+点击 任意链接 → 后台标签页（对齐 Chrome 语义）
 * 其余导航（普通链接、JS window.open 的 OAuth 弹窗等）不经此路径。
 */

const GUEST_OPEN_TAB_CHANNEL = "browser:guest-open-tab";

const isHttpLikeHref = (url: string): boolean => /^(https?|file):/i.test(url);

/** 链接生效的 target：显式 target 缺省时回退 <base target>。 */
const getEffectiveAnchorTarget = (anchor: Element): string =>
  anchor.getAttribute("target") ||
  document.querySelector("base")?.getAttribute("target") ||
  "";

let lastSentOpenTabKey = "";
let lastSentOpenTabAt = 0;

const sendGuestOpenTab = (url: string, background: boolean): void => {
  // 本地去重：同一激活序列中 mouseup 与 click/auxclick 会相继到达，
  // 短窗口内同 URL 同目标态只发送一次（主进程侧另有同 guest+URL 去重兜底）。
  const key = `${background ? "b" : "f"}\u0000${url}`;
  const now = Date.now();
  if (key === lastSentOpenTabKey && now - lastSentOpenTabAt < 300) return;
  lastSentOpenTabKey = key;
  lastSentOpenTabAt = now;
  ipcRenderer.send(GUEST_OPEN_TAB_CHANNEL, {
    url,
    disposition: background ? "background-tab" : "foreground-tab",
  });
};

const handleLinkActivation = (event: MouseEvent): void => {
  // 激活判定包含 mouseup 兜底：webview 中左键点击 target=_blank 时
  // Chromium 的辅助导航流程可能吞掉 click 事件（electron#30886 相关，
  // 中键 auxclick 不受影响）——mouseup 总是先于 click 派发且无法被
  // 辅助导航抑制，以它兜底保证左键点击稳定触发。
  const isActivation =
    (event.type === "click" && event.button === 0) ||
    (event.type === "auxclick" && event.button === 1) ||
    (event.type === "mouseup" && (event.button === 0 || event.button === 1));
  if (!isActivation) return;
  const anchor =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download")) return;
  let url: string;
  try {
    url = new URL(anchor.getAttribute("href") || "", document.baseURI).href;
  } catch {
    return;
  }
  if (!isHttpLikeHref(url)) return;
  // 中键 / Ctrl(⌘)+点击 → 后台标签页（对齐 Chrome 语义）。
  const background = event.button === 1 || event.ctrlKey || event.metaKey;
  // 普通左键激活只拦截 target=_blank 链接，其余交给页面默认导航。
  if (!background && getEffectiveAnchorTarget(anchor) !== "_blank") return;
  sendGuestOpenTab(url, background);
  // 阻止默认行为（webview 下默认开窗本就无效）与自动滚动等副作用。
  event.preventDefault();
};

const setup = (): void => {
  document.addEventListener("mouseup", handleLinkActivation, true);
  document.addEventListener("click", handleLinkActivation, true);
  document.addEventListener("auxclick", handleLinkActivation, true);
};

setup();
