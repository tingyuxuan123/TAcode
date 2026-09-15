import type { BrowserWindow } from "electron";

const READ = `(() => {
  const shell = document.querySelector('.inspect-shell');
  const toggle = document.querySelector('.inspect-toggle');
  return {
    open: !!shell && shell.getBoundingClientRect().width > 0,
    label: toggle ? toggle.getAttribute('aria-label') : null,
  };
})()`;

/**
 * 右侧抽屉在 Chat 里默认关闭（见 src/renderer/ui.tsx）。脚本要验证「面板已打开」的
 * 工作台布局时，先按用户路径点开一次：已经打开时是空操作，可在同一窗口重复调用。
 *
 * 只在 toggle 的 aria-label 确实是「打开右侧抽屉」时点一次：面板打开后宽度要等一帧才
 * 量得到，反复点击会把刚打开的面板又关回去。
 */
export async function ensureInspectDrawerOpen(win: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 5000;
  let clicked = false;
  while (Date.now() < deadline) {
    const state = (await win.webContents.executeJavaScript(READ)) as { open: boolean; label: string | null };
    if (state.open) return;
    if (!clicked && state.label === "打开右侧抽屉") {
      clicked = true;
      await win.webContents.executeJavaScript("document.querySelector('.inspect-toggle').click()");
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("右侧抽屉没有打开");
}
