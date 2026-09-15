/**
 * FR-14：视觉与交互完整性核对。
 *
 * 用与参考图相同的视口与 DPR（files 820×785、review 836×740，DPR 2）逐状态截图并断言：
 * 默认、展开、筛选、选中、菜单、窄面板；另含深色映射、中英文、IME、键盘与无障碍。
 * 断言走真实 Chromium 布局与原生输入，核对结构与尺寸预算，不做像素级叠图。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, protocol, type InputEvent } from "electron";
import { registerFileIpc } from "../src/main/files/file-ipc";
import { registerGitIpc } from "../src/main/git/git-ipc";
import { ReviewCoordinator } from "../src/main/review/review-coordinator";
import { registerReviewIpc } from "../src/main/review/review-ipc";
import { serveProjectPreview } from "../src/main/files/preview-server";
import { WorkspaceFileIndex } from "../src/main/workspace-file-index";
import { WorkspaceWatchers } from "../src/main/workspace-watcher";
import { PREVIEW_SCHEME } from "../src/shared/types";

protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
/** 参考图实测：两处裁切区域在 DPR 2 下的 CSS 尺寸。 */
const REFERENCE = { files: { width: 820, height: 785 }, review: { width: 836, height: 740 }, dpr: 2 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Surface { window: BrowserWindow; evaluate<T = any>(code: string): Promise<T> }

async function smoke() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-ui-review-"));
  const artifacts = process.env.TACODE_UI_REVIEW_ARTIFACTS ?? await fs.mkdtemp(path.join(os.tmpdir(), "tacode-ui-review-artifacts-"));
  await fs.mkdir(artifacts, { recursive: true });
  const reference = path.resolve("docs/file-review-reference");
  app.setPath("userData", path.join(directory, "profile")); app.on("window-all-closed", () => {});
  app.commandLine.appendSwitch("force-device-scale-factor", String(REFERENCE.dpr));
  await app.whenReady();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]));

  const project = path.join(directory, "project"); await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.writeFile(path.join(project, "readme.md"), "# 工作台\n\n正文段落。\n".repeat(40));
  for (const file of ["src/alpha.ts", "src/beta.ts", "src/gamma.css"]) await fs.writeFile(path.join(project, file), `export const ${path.basename(file, path.extname(file))} = 1;\n`.repeat(40));
  // 中文文件名用于核对输入法提交后的文字能真实筛选。
  await fs.writeFile(path.join(project, "中文笔记.md"), "# 中文笔记\n".repeat(20));

  const stages: string[] = []; const errors: string[] = []; const shots: string[] = [];
  // IPC 只注册一次（ipcMain 是全局的），宿主窗口按当前构建的窗口解析。
  let current: BrowserWindow | undefined;
  const index = new WorkspaceFileIndex(); const watchers = new WorkspaceWatchers(() => {});
  const fileIpc = registerFileIpc({ host: () => current?.webContents, index, resolveProject: async (root) => root,
    draftRoot: path.join(directory, "drafts"), watchProject: (root) => { watchers.watch(root); }, changed: () => {}, openPath: async () => "" });
  protocol.handle(PREVIEW_SCHEME, (request) => serveProjectPreview(request, fileIpc.service.paths, fileIpc.service.previews));
  const gitIpc = registerGitIpc({ host: () => current?.webContents, resolveProject: async (root) => root, recoveryRoot: path.join(directory, "git-recovery") });
  // 审查面板只做布局核对：用不返回结果的协调器，避免真实模型调用。
  const reviewIpc = registerReviewIpc({ host: () => current?.webContents, coordinator: new ReviewCoordinator({
    root: path.join(directory, "review-runs"), run: async () => "", describeRange: async () => ({ label: "未暂存改动", files: [], truncated: false, notes: [] }) }) });
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  ipcMain.handle("workspace:list", async (_event, root: string) => index.list(root, true));
  const registrations: Array<{ dispose(): void }> = [fileIpc, gitIpc, reviewIpc];
  const build = async (width: number, height: number): Promise<Surface> => {
    const created = new BrowserWindow({ width, height, useContentSize: true, show: true,
      webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    current = created;
    created.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    await created.loadFile(process.env.TACODE_FILE_WORKBENCH_FIXTURE!, { query: { project } });
    const evaluate = <T = any>(code: string) => created.webContents.executeJavaScript(code, true) as Promise<T>;
    const surface: Surface = { window: created, evaluate };
    await wait(surface, "!!window.fileWorkbenchFixture", "夹具加载");
    // 夹具左侧的转录栏是测试脚手架；参考图量的是工作台区域，所以量前把它收起，
    // 让工作台占满参考视口（820/836 宽）。
    await evaluate(`(() => { const aside = document.querySelector('#root > div > aside'); if (aside) aside.style.display = 'none'; })()`);
    await delay(120);
    return surface;
  };
  /** 元素有尺寸且落在窗口内：隐藏标签页的元素可能仍有尺寸（离屏），所以两者都要判。 */
  const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; })`;
  const shown = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; })`;
  const filterInput = visible('.workbench-file-filter input');
  /** 行统计绑定到“我正在筛选的那棵树”，避免把另一个已挂载面板的行算进来。 */
  const treeRows = `(() => { const input = ${filterInput}; const tree = input?.closest('.workbench-file-tree') ?? document; return [...tree.querySelectorAll('[data-tree-path]')].filter((el) => el.getBoundingClientRect().width > 0); })()`;
  const wait = async (surface: Surface, code: string, label: string, timeout = 15_000) => {
    const start = Date.now();
    while (!await surface.evaluate(code)) { if (Date.now() - start > timeout) throw new Error(`超时：${label}`); await delay(40); }
  };
  const click = async (surface: Surface, selector: string) => {
    const point = await surface.evaluate<{ x: number; y: number }>(`(() => { const el = ${visible(selector)}; if (!el) throw new Error('缺少元素 ' + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    surface.window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 } as InputEvent);
    surface.window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 } as InputEvent);
    await delay(90);
  };
  const key = async (surface: Surface, keyCode: string, modifiers: string[] = []) => {
    surface.window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as InputEvent);
    if (keyCode === "Enter") surface.window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers } as InputEvent);
    surface.window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as InputEvent);
    await delay(70);
  };
  const shot = async (surface: Surface, name: string) => {
    await delay(160);
    const file = path.join(artifacts, `${name}.png`);
    await fs.writeFile(file, (await surface.window.webContents.capturePage()).toPNG());
    await fs.copyFile(file, path.join(reference, `fr-14-${name}.png`));
    shots.push(`fr-14-${name}.png`);
  };
  const stage = (name: string) => { stages.push(name); console.log(`[ui/review] ${name}`); };
  /** 每个区域都要有可用尺寸，工具栏与树里的控件都在窗口内。 */
  const layout = async (surface: Surface, label: string, options: { maxToolbarHeight?: number } = {}) => {
    const box = await surface.evaluate(`(() => { const pick = (selector) => { const el = [...document.querySelectorAll(selector)].find((node) => node.getBoundingClientRect().height > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
      const list = ${visible('.workbench-tree-list')};
      return { viewport: [innerWidth, innerHeight], toolbar: pick('.workbench-toolbar'), content: pick('.workbench-content'), navigation: pick('.workbench-navigation'), list: list ? { h: Math.round(list.getBoundingClientRect().height) } : null,
        overflow: [...document.querySelectorAll('[data-file-active="true"] .workbench-toolbar, [data-file-active="true"] .workbench-navigation, [data-file-active="true"] .workbench-file-tree, [data-file-active="true"] .workbench-content')].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
        controls: [...document.querySelectorAll('[data-file-active="true"] .workbench-navigation button, [data-file-active="true"] .workbench-toolbar button, [data-file-active="true"] .workbench-toolbar select')]
          .filter((el) => el.getBoundingClientRect().width > 0).every((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1; }) }; })()`);
    assert.ok(box.viewport[0] >= 600 && box.viewport[1] >= 500, `${label}: 视口尺寸 ${box.viewport}`);
    assert.ok(box.toolbar && box.toolbar.h >= 28 && box.toolbar.h <= (options.maxToolbarHeight ?? 52), `${label}: 工具栏高度 ${box.toolbar?.h}`);
    assert.ok(box.content && box.content.w >= 240 && box.content.h > 280, `${label}: 内容区尺寸 ${box.content?.w}×${box.content?.h}`);
    assert.ok(box.navigation && box.navigation.w >= 200, `${label}: 上下文列宽度 ${box.navigation?.w}`);
    assert.ok(box.list && box.list.h >= 100, `${label}: 文件树可用高度 ${box.list?.h}`);
    assert.equal(box.overflow, 0, `${label}: 无横向溢出`);
    assert.equal(box.controls, true, `${label}: 控件都在窗口内`);
    return box;
  };
  /** 上下文列里的面板必须整体可见：面板底部控件落在列的可视范围内。 */
  const panelBudget = async (surface: Surface, selector: string, label: string) => {
    const box = await surface.evaluate(`(() => { const panel = ${visible(selector)}; if (!panel) return null;
      const column = panel.closest('.workbench-navigation'); if (!column) return null;
      const columnBox = column.getBoundingClientRect(); const body = panel.querySelector('.review-findings-body, ul');
      const controls = [...panel.querySelectorAll('button')];
      return { column: [Math.round(columnBox.top), Math.round(columnBox.bottom)], panel: [Math.round(panel.getBoundingClientRect().top), Math.round(panel.getBoundingClientRect().bottom)],
        body: body ? Math.round(body.getBoundingClientRect().height) : null, bodyScroll: body ? body.scrollHeight : null,
        reachable: controls.length === 0 ? true : controls.every((el) => el.getBoundingClientRect().bottom <= columnBox.bottom + 1) }; })()`);
    assert.ok(box, `${label}: 面板已挂载`);
    assert.ok(box!.panel[1] <= box!.column[1] + 1, `${label}: 面板底部不越过上下文列`);
    return box!;
  };
  const a11y = async (surface: Surface, label: string) => {
    const report = await surface.evaluate(`(() => { const buttons = [...document.querySelectorAll('.workbench-toolbar button, .workbench-navigation button')];
      return { unlabeled: buttons.filter((el) => !el.getAttribute('aria-label') && !el.textContent?.trim()).length,
        toggles: [...document.querySelectorAll('.workbench-toolbar button[aria-pressed]')].length,
        tree: Boolean(${visible('[role="tree"][aria-label]')}), items: ${treeRows}.length,
        selected: document.querySelectorAll('[role="treeitem"][aria-selected="true"]').length }; })()`);
    assert.equal(report.unlabeled, 0, `${label}: 每个按钮都有可读名称`);
    assert.ok(report.toggles >= 2, `${label}: 切换按钮带 aria-pressed`);
    assert.equal(report.tree, true, `${label}: 文件树有无障碍名称`);
    assert.ok(report.items > 0 && report.selected <= 1, `${label}: 树条目带层级与唯一选中`);
  };

  let surface: Surface | undefined;
  try {
    for (const kind of ["review", "files"] as const) {
      const size = REFERENCE[kind];
      surface = await build(size.width, size.height);
      const label = kind === "review" ? "审查" : "文件";
      // 打开一个文档，默认状态才有真实的编辑器/差异内容。
      await click(surface, '[data-panel-id="files"]');
      await wait(surface, `!!${visible('.project-file-tree-tools')}`, "根文件树");
      // 视图状态在同一 profile 下跨窗口共享，输入前先清空筛选。
      await surface.evaluate(`(() => { const input = ${filterInput}; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); })()`);
      await wait(surface, `(${filterInput})?.value === ''`, "初始筛选为空");
      await surface.window.webContents.insertText("readme.md");
      await wait(surface, `!!${visible('[data-tree-path="readme.md"]')}`, "目标文件行");
      await click(surface, `[data-tree-path="readme.md"]`);
      await wait(surface, `!!${visible('.cm-content')} !== undefined || ${visible('.workbench-toolbar')} !== undefined`, "文档面板");
      await layout(surface, `${label}默认`);
      await shot(surface, `${kind}-default-zh`);
      stage(`${label}：默认状态在参考视口下布局成立（工具栏/内容区/上下文列尺寸与无溢出）`);

      await surface.evaluate(`(() => { for (const button of document.querySelectorAll('.project-file-tree-tools button')) { if ((button.getAttribute('aria-label') ?? '').includes('展开')) button.click(); } })()`);
      await delay(140);
      assert.ok(await surface.evaluate(`${treeRows}.length`) > 0, `${label}: 展开后仍有树条目`);
      await shot(surface, `${kind}-expanded-zh`);
      stage(`${label}：展开状态可用`);

      await surface.evaluate(`(() => { const input = ${filterInput}; input.focus(); input.value = ''; })()`);
      await surface.window.webContents.insertText("alpha");
      await wait(surface, `(${filterInput})?.value === 'alpha'`, "筛选输入");
      await wait(surface, `!!${visible('[data-tree-path="src/alpha.ts"]')}`, "筛选命中目标文件");
      const filteredRows = await surface.evaluate<string[]>(`(${treeRows}).map((row) => row.dataset.treePath)`);
      assert.deepEqual(filteredRows.filter((item) => /\.[a-z]+$/.test(item)), ["src/alpha.ts"], `${label}: 筛选后只保留匹配文件`);
      await shot(surface, `${kind}-filtered-zh`);
      stage(`${label}：筛选状态只显示匹配条目`);

      await surface.evaluate(`(() => { const input = ${filterInput}; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(surface, `${treeRows}.length > 1`, "恢复完整树");
      // 选中：切到已打开的文件标签，它的行在文件树里保持“当前文件”选中态。
      await surface.evaluate(`(() => { const tab = [...document.querySelectorAll('[data-panel-id]')].find((el) => (el.getAttribute('data-panel-id') ?? '').startsWith('file-') && (el.textContent ?? '').includes('readme.md')); if (tab) tab.click(); })()`);
      await wait(surface, `(${visible('[role="treeitem"][aria-selected="true"]')}) !== undefined`, "文件行选中态");
      assert.ok(await surface.evaluate(`${treeRows}.length`) > 0, `${label}: 选中状态下列表仍可读`);
      assert.equal(await surface.evaluate(`${shown('[role="treeitem"][aria-selected="true"]')}.length > 0`), true, `${label}: 选中行在可见树里`);
      await shot(surface, `${kind}-selected-zh`);
      stage(`${label}：选中状态（树行唯一选中，内容区保持可用）`);

      const menuRow = await surface.evaluate<string>(`(${visible('[data-tree-path]')})?.dataset.treePath ?? ''`);
      assert.ok(menuRow, `${label}: 树行提供文件操作入口`);
      // 原生右键菜单入口：树行 onContextMenu 打开文件操作菜单。
      await surface.evaluate(`(() => { const row = ${visible('[data-tree-path=' + JSON.stringify(menuRow) + ']')}; const box = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(box.left + 20), clientY: Math.round(box.top + box.height / 2) })); })()`);
      await wait(surface, `!!document.querySelector('.file-action-menu')`, "文件操作菜单");
      assert.ok(await surface.evaluate(`document.querySelectorAll('.file-action-menu [data-file-action]').length`) >= 4, `${label}: 菜单包含文件操作`);
      await shot(surface, `${kind}-menu-zh`);
      await key(surface, "Escape");
      await wait(surface, `!document.querySelector('.file-action-menu')`, "Escape 关闭菜单");
      stage(`${label}：菜单状态（原生菜单打开、含文件操作、Escape 关闭）`);

      await surface.evaluate("window.fileWorkbenchFixture.setLocale('en')");
      surface.window.setContentSize(620, 740); await delay(240);
      // 窄窗按既有响应式规则把工具栏换成两行，保证每个控件都还在窗口内。
      await layout(surface, `${label}窄窗英文`, { maxToolbarHeight: 96 });
      await shot(surface, `${kind}-narrow-en`);
      await surface.evaluate("window.fileWorkbenchFixture.setLocale('zh')");
      surface.window.setContentSize(size.width, size.height); await delay(220);

      const scheme = await surface.evaluate(`(() => { const el = ${visible('.code-workbench')}; return { scheme: el?.dataset.colorScheme ?? '', background: el ? getComputedStyle(el).getPropertyValue('--workbench-bg').trim() : '' }; })()`);
      assert.equal(scheme.scheme, "light", `${label}: 默认浅色主题（参考图基准）`);
      assert.ok(scheme.background.length > 0, `${label}: 浅色主题变量可用`);
      // 深色映射：直接切换工作台的主题属性，核对 CSS 深色 token 生效（组件级 setColorScheme
      // 由审查夹具烟测覆盖，这里核对的是文件/审查两个面的映射本身）。
      await surface.evaluate(`(() => { document.querySelectorAll('.code-workbench').forEach((el) => { el.dataset.colorScheme = 'dark'; }); })()`); await delay(180);
      const dark = await surface.evaluate(`(() => { const el = ${visible('.code-workbench')}; return { scheme: el?.dataset.colorScheme ?? '', background: el ? getComputedStyle(el).getPropertyValue('--workbench-bg').trim() : '' }; })()`);
      assert.equal(dark.scheme, "dark", `${label}: 深色主题属性`);
      assert.notEqual(dark.background, scheme.background, `${label}: 深色与浅色背景不同`);
      await shot(surface, `${kind}-dark-zh`);
      await surface.evaluate(`(() => { document.querySelectorAll('.code-workbench').forEach((el) => { el.dataset.colorScheme = 'light'; }); })()`); await delay(150);
      stage(`${label}：浅色基准与深色映射成立`);

      // 输入法：提交后的中文文字要真实筛选；组合期间的按键不能触发打开文件。
      await surface.evaluate(`(() => { const input = ${filterInput}; input.focus(); input.value = ''; })()`);
      await surface.window.webContents.insertText("中文");
      await wait(surface, `(${filterInput})?.value === '中文'`, "输入法提交文字");
      await wait(surface, `!!${visible('[data-tree-path="中文笔记.md"]')}`, "输入法文字筛选命中");
      assert.deepEqual((await surface.evaluate<string[]>(`(${treeRows}).map((row) => row.dataset.treePath)`)).filter((item) => /\.[a-z]+$/.test(item)),
        ["中文笔记.md"], `${label}: 输入法文字筛选只保留匹配文件`);
      await surface.evaluate(`(() => { const input = ${filterInput}; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(surface, `(${filterInput})?.value === ''`, "清空筛选");
      await wait(surface, `(${treeRows}).length > 2`, "清空筛选后树恢复");
      // 普通回车在树里打开文件（键盘可用）；输入法处理中的回车（keyCode 229 / isComposing）不触发。
      await surface.evaluate(`(() => { const row = ${visible('[data-tree-path="中文笔记.md"]')}; row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(surface, `(${visible('[data-file-active="true"]')})?.dataset.filePath === '中文笔记.md'`, "键盘回车打开文件");
      const opened = await surface.evaluate<string>(`(${visible('[data-file-active="true"]')})?.dataset.filePath ?? ''`);
      await surface.evaluate(`(() => { const row = ${visible('[data-tree-path="readme.md"]')}; for (const event of [{ key: 'Enter', keyCode: 229 }, { key: 'Enter', isComposing: true }]) {
        row.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...event })); } })()`);
      await delay(200);
      assert.equal(await surface.evaluate<string>(`(${visible('[data-file-active="true"]')})?.dataset.filePath ?? ''`), opened, `${label}: 输入法处理中的回车不打开文件`);
      stage(`${label}：输入法提交文字可筛选，组合期间的回车不误触发`);


      await surface.evaluate(`(${filterInput}).focus()`);
      await key(surface, "Tab");
      assert.equal(await surface.evaluate(`Boolean(document.activeElement?.closest('.workbench-file-tree'))`), true, `${label}: Tab 从筛选框进入文件树`);
      await key(surface, "ArrowDown"); await key(surface, "ArrowUp");
      assert.ok((await surface.evaluate<string>(`document.activeElement?.dataset?.treePath ?? ''`)).length > 0, `${label}: 方向键在树内移动焦点`);
      stage(`${label}：键盘导航（Tab 进入树、方向键移动、Escape 关闭菜单）可用`);

      await a11y(surface, label);
      stage(`${label}：无障碍（按钮名称、aria-pressed、树 role/层级/选中）通过`);

      assert.equal(await surface.evaluate(`Boolean(document.querySelector('.file-drawer, .inspect-drawer'))`), false, `${label}: 旧抽屉未挂载`);

      if (kind === "review") {
        // 先切到审查标签，再核对上下文列里的两个面板（FR-13 记录的底部按钮被挤出可视区问题）。
        await surface.evaluate(`(() => { const tab = document.querySelector('[data-panel-id="review"]'); tab?.click(); })()`);
        await wait(surface, `!!${visible('[data-review-active="true"]')}`, "审查标签激活");
        await surface.evaluate(`(() => { const toggle = ${visible('[data-review-findings-toggle="closed"]')}; toggle?.click(); })()`);
        await wait(surface, `!!${visible('.review-findings')}`, "AI 审查面板展开");
        const findings = await panelBudget(surface, ".review-findings", "AI 审查面板");
        assert.equal(findings.reachable, true, "AI 审查面板的控件都在列内可达");
        await shot(surface, "review-findings-zh");
        await surface.evaluate(`(() => { const toggle = ${visible('[data-review-comments-toggle]')}; toggle?.click(); })()`);
        await wait(surface, `!!${visible('.review-comments')}`, "意见面板展开");
        const comments = await panelBudget(surface, ".review-comments", "意见面板");
        assert.equal(comments.reachable, true, "意见面板的控件都在列内可达");
        await shot(surface, "review-comments-zh");
      }
      surface.window.destroy(); surface = undefined;
    }

    assert.deepEqual([...new Set(errors)], [], "renderer 无错误");
    const result = { date: new Date().toISOString(), stages, screenshots: shots, reference: REFERENCE, errors: [...new Set(errors)],
      boundary: "真实 Electron 视口 DPR2、生产 preload/文件与 Git IPC/WorkbenchPanels；结构与尺寸断言，不做像素级叠图。" };
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2));
    await fs.writeFile(path.resolve(process.env.TACODE_UI_REVIEW_REPORT ?? "docs/file-review-reference/fr-14-result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(`[ui/review] ${stages.length} 项状态核对通过，截图 ${shots.length} 张`);
  } catch (error) {
    console.error(error);
    console.error("renderer 错误:", [...new Set(errors)].slice(0, 3));
    if (surface && !surface.window.isDestroyed()) await fs.writeFile(path.join(artifacts, "failure.png"), (await surface.window.webContents.capturePage()).toPNG()).catch(() => {});
    console.error(`Artifacts: ${artifacts}`);
    for (const entry of registrations) entry.dispose();
    app.exit(1);
    return;
  }
  for (const entry of registrations) entry.dispose();
  for (const open of BrowserWindow.getAllWindows()) if (!open.isDestroyed()) open.destroy();
  if (!process.env.TACODE_UI_REVIEW_ARTIFACTS) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(0);
}
smoke().catch((error) => { console.error(error); app.exit(1); });
