/**
 * 从 Electron webview 截取整页截图。
 *
 * 移植自 Snow App（MIT）captureWebviewPage.ts。
 * `webview.capturePage()` 只捕获可见视口；为避免滚动条裁剪并捕获整个
 * 可滚动页面：注入 CSS 隐藏滚动条 → 读取整页尺寸 → 临时把 webview 元素
 * 放大到整页尺寸 → 等两帧重排 → capturePage → 恢复原状（即使出错也恢复）。
 */

const HIDE_SCROLLBAR_STYLE_ID = "__screenshot-hide-scrollbar";

const injectScrollbarHider = async (webview: Electron.WebviewTag): Promise<void> => {
  await webview.executeJavaScript(
    "(() => {" +
      "  const existing = document.getElementById('" +
      HIDE_SCROLLBAR_STYLE_ID +
      "');" +
      "  if (existing) return;" +
      "  const style = document.createElement('style');" +
      "  style.id = '" +
      HIDE_SCROLLBAR_STYLE_ID +
      "';" +
      "  style.textContent =" +
      "    '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}'" +
      "    + 'html{scrollbar-width:none!important;-ms-overflow-style:none!important}';" +
      "  document.head.appendChild(style);" +
      "})();",
  );
};

const removeScrollbarHider = async (webview: Electron.WebviewTag): Promise<void> => {
  await webview.executeJavaScript(
    "document.getElementById('" + HIDE_SCROLLBAR_STYLE_ID + "')?.remove();",
  );
};

type PageDimensions = {
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
};

const getPageDimensions = async (webview: Electron.WebviewTag): Promise<PageDimensions> => {
  return webview.executeJavaScript(
    "(() => {" +
      "  const el = document.documentElement;" +
      "  return {" +
      "    scrollWidth: el.scrollWidth," +
      "    scrollHeight: el.scrollHeight," +
      "    clientWidth: el.clientWidth," +
      "    clientHeight: el.clientHeight," +
      "  };" +
      "})();",
  );
};

/** 等两帧动画，让 webview 在改尺寸后完成重排。 */
const waitForRerender = async (webview: Electron.WebviewTag): Promise<void> => {
  await webview.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
};

/** 截取 webview 整页内容为 PNG data URL；退出前总是恢复页面原状。 */
export const captureWebviewPage = async (webview: Electron.WebviewTag): Promise<string> => {
  const restoreTasks: Array<() => Promise<void> | void> = [];

  try {
    await injectScrollbarHider(webview);
    restoreTasks.push(() => removeScrollbarHider(webview));

    const { scrollWidth, scrollHeight, clientWidth, clientHeight } = await getPageDimensions(webview);
    const needsResize = scrollHeight > clientHeight || scrollWidth > clientWidth;

    if (needsResize) {
      const originalCssText = webview.style.cssText;
      webview.style.width = scrollWidth + "px";
      webview.style.height = scrollHeight + "px";
      restoreTasks.unshift(() => {
        webview.style.cssText = originalCssText;
      });
      await waitForRerender(webview);
    }

    const image = await webview.capturePage();
    const dataUrl = image.toDataURL();
    if (!dataUrl) throw new Error("Captured image is empty");
    return dataUrl;
  } finally {
    for (const task of restoreTasks) {
      try {
        await task();
      } catch {
        // Ignore restoration errors.
      }
    }
  }
};
