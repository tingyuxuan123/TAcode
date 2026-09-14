import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { registerCapabilitiesIpc } from "../src/main/capabilities-ipc";
import { SkillsManager } from "../src/main/skills-manager";
import { isPathInsideRoot } from "../src/main/workspace-path";

async function smoke(): Promise<void> {
app.on("window-all-closed", () => {});
const repository = process.cwd();
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-capability-smoke-"));
const home = path.join(root, "runtime-home");
const project = path.join(root, "TACode");
const other = path.join(root, "other-project");
const importSource = path.join(root, "import-source");
process.env.TACODE_HOME = home;
app.setPath("userData", path.join(root, "electron"));
let main: BrowserWindow | undefined;
let stage = "initialize";
const rendererErrors: string[] = [];
const watchdog = setTimeout(() => { console.error(`Capabilities smoke timeout: ${stage}`); app.exit(1); }, 90_000);
const host = <T = unknown>(source: string): Promise<T> => main!.webContents.executeJavaScript(source, true);
const visible = "Array.from(document.querySelectorAll('.cap-panel')).find(el => el.getBoundingClientRect().width > 0)";
const wait = async (predicate: () => Promise<unknown>, timeout = 8_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error(`Timed out: ${stage}`);
};
const clickText = (label: string) => host(`(() => { const root = ${visible} ?? document; const button = Array.from(root.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0); if (!button) throw new Error('Button missing: ' + ${JSON.stringify(label)}); button.click(); })()`);
const setField = (label: string, value: string) => host(`(() => { const root = ${visible}; const holder = Array.from(root.querySelectorAll('label')).find(el => el.firstChild?.textContent.trim() === ${JSON.stringify(label)}); const input = holder?.querySelector('input,textarea,select') ?? root.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!input) throw new Error('Field missing: ' + ${JSON.stringify(label)}); const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
const fieldValue = (label: string) => host<string>(`(() => { const root = ${visible}; const holder = Array.from(root.querySelectorAll('label')).find(el => el.firstChild?.textContent.trim() === ${JSON.stringify(label)}); const input = holder?.querySelector('input,textarea,select') ?? root.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!input) throw new Error('Field missing: ' + ${JSON.stringify(label)}); return input.value; })()`);
const clickLabel = (label: string) => host(`(() => { const root = ${visible} ?? document; const button = Array.from(root.querySelectorAll('button')).find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!button) throw new Error('Label missing: ' + ${JSON.stringify(label)}); button.click(); })()`);
const tab = (name: string) => host(`Array.from(document.querySelectorAll('[role=tab]')).find(el => el.querySelector('.inspect-tab-label')?.textContent === ${JSON.stringify(name)}).click()`);
const panelText = () => host<string>(`(${visible})?.textContent ?? ''`);
const document = (name: string, description: string, group: string) => `---\nname: ${name}\ndescription: ${description}\ngroup: ${group}\nversion: 1.0.0\n---\n\n# ${name}\n\n先理解任务，再执行并验证结果。\n`;
const screenshot = async (name: string) => {
  const output = process.env.TACODE_CAPABILITIES_ARTIFACTS;
  if (!output) return;
  await host("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(output, name), (await main!.webContents.capturePage()).toPNG());
};

try {
  await Promise.all([home, project, other, importSource].map((folder) => fsp.mkdir(folder, { recursive: true })));
  await fsp.writeFile(path.join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  new ProjectTrustStore(home).setMany([{ path: project, decision: true }, { path: other, decision: true }]);
  const skills = new SkillsManager(path.join(root, "user"));
  await skills.create(document("code-review", "检查改动的正确性，找到会影响用户的实际问题，并给出可执行的修改建议。", "开发效率"), "project", project);
  await skills.create(document("writing-plans", "在多步任务开始前整理目标、执行步骤和验证方式，让复杂改动有据可查。", "开发效率"), "project", project);
  await skills.create(document("docs-helper", "阅读并整理项目文档，保持说明与当前实现一致，输出清晰易读的中文内容。", "文档与写作"), "project", project);
  await fsp.writeFile(path.join(importSource, "SKILL.md"), document("imported-skill", "导入测试", "开发效率"));
  await fsp.mkdir(path.join(importSource, "scripts")); await fsp.writeFile(path.join(importSource, "scripts/run.py"), "print('ok')\n");
  Object.defineProperty(dialog, "showOpenDialog", { value: async () => ({ canceled: false, filePaths: [importSource] }) });
  Object.defineProperty(shell, "trashItem", { value: async (directory: string) => fsp.rename(directory, path.join(root, `trash-${path.basename(directory)}`)) });
  stage = "wait for Electron ready";
  await app.whenReady();
  ipcMain.handle("app:get-locale", () => "zh");
  ipcMain.handle("workspace:recent", () => [{ path: project }, { path: other }]);
  const validateProject = async (cwd: string) => { assert.ok([project, other].includes(cwd)); return cwd; };
  registerCapabilitiesIpc({ resolveWorkspace: validateProject, resolveProjectFile: async (file, cwd) => { await validateProject(cwd); const target = path.resolve(cwd, file); assert.ok(isPathInsideRoot(cwd, target)); return target; }, changed: (cwd) => main?.webContents.send("capabilities:changed", cwd), runtimeStatus: async () => ({ state: "inactive" }), reloadRuntime: async () => { throw new Error("No runtime in this fixture"); } });
  main = new BrowserWindow({ width: 1440, height: 980, show: true, backgroundColor: "#f6f4f0", ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } } : {}), webPreferences: { preload: path.join(repository, "dist-electron/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  main.webContents.on("console-message", (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  stage = "load renderer fixture";
  await main.loadFile(process.env.TACODE_CAPABILITY_FIXTURE!);
  await wait(() => host("!!document.querySelector('[data-project=\"0\"]')"));
  stage = "open both capability tabs from sidebar";
  await host("document.querySelector('[aria-label=\"Skills / MCP\"]').click()");
  await wait(async () => (await panelText()).includes("code-review"));
  assert.equal(await host("document.querySelectorAll('[role=tab]').length"), 3);
  await screenshot("skills-panel.png");
  await tab("MCP");
  await wait(async () => (await panelText()).includes("Filesystem"));
  await screenshot("mcp-panel.png");
  stage = "scope dropdown opens below its trigger without truncating labels";
  await host(`(${visible}).querySelector('.cap-scope-dropdown .dropdown-select-trigger').click()`);
  await wait(() => host("!!document.querySelector('.dropdown-select-panel')"));
  const dropdown = await host<{ panelTop: number; triggerBottom: number; panelWidth: number; longestLabel: number }>(`(() => {
    const triggerEl = (${visible}).querySelector('.cap-scope-dropdown .dropdown-select-trigger');
    const panel = document.querySelector('.dropdown-select-panel');
    const labels = Array.from(panel.querySelectorAll('.dropdown-select-option-label'));
    return {
      panelTop: panel.getBoundingClientRect().top,
      triggerBottom: triggerEl.getBoundingClientRect().bottom,
      panelWidth: panel.getBoundingClientRect().width,
      longestLabel: Math.max(...labels.map((label) => label.scrollWidth)) + 24,
    };
  })()`);
  assert.ok(dropdown.panelTop >= dropdown.triggerBottom, `面板应贴在触发器下方：${JSON.stringify(dropdown)}`);
  assert.ok(dropdown.panelWidth >= dropdown.longestLabel, `面板不能截断选项文案：${JSON.stringify(dropdown)}`);
  await host("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await wait(() => host("!document.querySelector('.dropdown-select-panel')"));

  await tab("Skills"); await clickText("新建技能");
  await setField("技能名称", "created-in-sidebar"); await setField("描述", "A real saved skill"); await setField("技能说明", "Do the work."); await clickText("保存");
  await wait(async () => (await panelText()).includes("编辑 SKILL.md"));
  const skillFile = path.join(project, ".agents/skills/created-in-sidebar/SKILL.md");
  assert.match(await fsp.readFile(skillFile, "utf8"), /Do the work/);
  await clickText("在对话中使用"); assert.equal(await host("document.querySelector('[aria-label=消息]').value"), "/skill:created-in-sidebar ");
  await setField("编辑 SKILL.md", `${await fsp.readFile(skillFile, "utf8")}\nSaved in the editor.\n`); await clickText("保存");
  await wait(async () => (await panelText()).includes("已保存")); assert.match(await fsp.readFile(skillFile, "utf8"), /Saved in the editor/);
  stage = "guard unsaved edits when closing a tab";
  await setField("编辑 SKILL.md", `${await fsp.readFile(skillFile, "utf8")}\nUnsaved.\n`);
  // 等待编辑器把 dirty 状态上报到外层再关标签，避免与 React 状态传播竞态。
  await wait(async () => (await panelText()).includes("有未保存"));
  await host("Array.from(document.querySelectorAll('[role=tab]')).find(el => el.querySelector('.inspect-tab-label')?.textContent === 'Skills').querySelector('.inspect-tab-close').click()");
  await wait(() => host("document.querySelector('[role=dialog]')?.textContent.includes('放弃未保存')"));
  await host("Array.from(document.querySelectorAll('[role=dialog] button')).find(el => el.textContent === '继续编辑').click()");
  assert.ok((await panelText()).includes("有未保存"));
  await setField("编辑 SKILL.md", await fsp.readFile(skillFile, "utf8")); await clickLabel("返回列表");
  await clickLabel("启用 created-in-sidebar");
  await wait(async () => { try { await fsp.access(path.join(project, ".agents/skills-inactive/created-in-sidebar/SKILL.md")); return true; } catch { return false; } });
  await clickLabel("启用 created-in-sidebar"); await wait(async () => { try { await fsp.access(skillFile); return true; } catch { return false; } });
  stage = "collapse and restore a skill group";
  const groupOpen = () => host<boolean>(`Array.from((${visible}).querySelectorAll('.cap-group')).find(el => el.querySelector('summary span')?.textContent === '开发效率')?.open ?? false`);
  const groupSummary = `Array.from((${visible}).querySelectorAll('.cap-group')).find(el => el.querySelector('summary span')?.textContent === '开发效率').querySelector('summary')`;
  await host(`(${groupSummary}).click()`);
  await wait(async () => !(await groupOpen()));
  assert.ok(await host(`localStorage.getItem('skills:collapsed-groups')?.includes('开发效率') ?? false`));
  await host(`(${groupSummary}).click()`);
  await wait(groupOpen);

  stage = "search and import a skill folder";
  await setField("搜索技能…", "created-in-sidebar");
  assert.equal(await host(`(${visible}).querySelectorAll('.cap-skill-card').length`), 1);
  await clickLabel("清除搜索"); await clickText("导入");
  await wait(async () => (await panelText()).includes("imported-skill"));
  assert.equal(await fsp.readFile(path.join(project, ".agents/skills/imported-skill/scripts/run.py"), "utf8"), "print('ok')\n");

  stage = "configure and test a real stdio MCP from the sidebar";
  await tab("MCP"); await clickText("添加服务器");
  await setField("服务器名称", "local-fixture"); await setField("启动命令", process.env.TACODE_TEST_NODE!); await setField("启动参数", JSON.stringify([path.join(repository, "scripts/fixtures/mcp-server.mjs")]));
  await setField("环境变量", "MCP_FIXTURE_VALUE=sidebar"); await clickText("测试连接");
  await wait(async () => (await panelText()).includes("测试通过 · 2 个工具"));
  assert.ok((await panelText()).includes("echo"));
  await host(`(${visible}).querySelector('.cap-test-result').scrollIntoView({ block: 'center' })`);
  await screenshot("mcp-connection-test.png");
  await clickText("保存"); await wait(async () => (await panelText()).includes("项目服务器"));
  const mcpFile = path.join(project, ".tacode/mcp.json");
  assert.equal(JSON.parse(await fsp.readFile(mcpFile, "utf8")).mcpServers["local-fixture"].env.MCP_FIXTURE_VALUE, "sidebar");
  await clickLabel("启用 local-fixture");
  await wait(async () => JSON.parse(await fsp.readFile(mcpFile, "utf8")).mcpServers["local-fixture"].disabled === true);
  stage = "JSON import, duplicate errors and scope isolation";
  await clickText("导入"); await setField("导入 JSON 配置", '{"servers":{"remote-fixture":{"type":"sse","url":"http://127.0.0.1:9/sse","enabled":false,"headers":{"Authorization":"Bearer fixture"}}}}'); await clickText("导入");
  await wait(async () => (await panelText()).includes("remote-fixture"));
  await host("document.querySelector('[data-project=\"1\"]').click()");
  await wait(async () => !(await panelText()).includes("local-fixture") && (await panelText()).includes("还没有 MCP"));
  await host("document.querySelector('[data-project=\"0\"]').click()");
  await wait(async () => (await panelText()).includes("local-fixture"));
  await setField("配置范围", "user");
  await wait(async () => (await panelText()).includes("还没有 MCP"));
  assert.ok(!(await panelText()).includes("remote-fixture"));
  await setField("配置范围", "project"); await wait(async () => (await panelText()).includes("remote-fixture"));
  await clickLabel("移除 remote-fixture");
  await wait(() => host("!!document.querySelector('[role=dialog]')"));
  await host("Array.from(document.querySelectorAll('[role=dialog] button')).find(el => el.textContent === '移除').click()");
  await wait(async () => !JSON.parse(await fsp.readFile(mcpFile, "utf8")).mcpServers["remote-fixture"]);
  await wait(async () => !(await panelText()).includes("remote-fixture"));

  stage = "create and test a server from pasted JSON in the editor";
  await clickText("添加服务器"); await clickText("JSON");
  await setField("完整配置", JSON.stringify({ "json-fixture": { command: process.env.TACODE_TEST_NODE!, args: [path.join(repository, "scripts/fixtures/mcp-server.mjs")], env: { MCP_FIXTURE_VALUE: "json" } } }));
  await clickText("测试连接");
  await wait(async () => (await panelText()).includes("测试通过 · 2 个工具"));
  await screenshot("mcp-json-mode.png");
  await clickText("表单");
  assert.equal(await fieldValue("服务器名称"), "json-fixture");
  await clickText("JSON");
  const regenerated = JSON.parse(await fieldValue("完整配置"));
  assert.equal(regenerated["json-fixture"].command, process.env.TACODE_TEST_NODE);
  assert.deepEqual(regenerated["json-fixture"].env, { MCP_FIXTURE_VALUE: "json" });
  assert.equal(regenerated["json-fixture"].timeout, 20);
  await clickText("保存"); await wait(async () => (await panelText()).includes("项目服务器"));
  assert.equal(JSON.parse(await fsp.readFile(mcpFile, "utf8")).mcpServers["json-fixture"].env.MCP_FIXTURE_VALUE, "json");

  stage = "reject a multi-server JSON and discard it with cancel";
  await clickText("添加服务器"); await clickText("JSON");
  await setField("完整配置", '{"mcpServers":{"a-fixture":{"command":"node"},"b-fixture":{"command":"node"}}}');
  await clickText("保存");
  await wait(() => host<boolean>(`!!(${visible}).querySelector('.cap-notice.is-error')`));
  assert.match(await host<string>(`(${visible}).querySelector('.cap-notice.is-error').textContent`), /一次只能保存一个/);
  assert.ok(!JSON.parse(await fsp.readFile(mcpFile, "utf8")).mcpServers["a-fixture"]);
  await clickText("取消");
  await wait(() => host("document.querySelector('[role=dialog]')?.textContent.includes('放弃未保存')"));
  await host("Array.from(document.querySelectorAll('[role=dialog] button')).find(el => el.textContent === '放弃修改').click()");
  await wait(async () => (await panelText()).includes("项目服务器"));

  stage = "paste a wrapped config and save it into the global scope";
  await clickText("添加服务器"); await clickText("JSON");
  await setField("完整配置", '{"mcpServers":{"wrapped-fixture":{"type":"sse","url":"http://127.0.0.1:9/sse","headers":{"Authorization":"Bearer fixture"}}}}');
  await setField("配置范围", "user");
  await clickText("保存");
  await wait(async () => (await panelText()).includes("已保存"));
  await wait(async () => (await panelText()).includes("wrapped-fixture"));
  const wrapped = JSON.parse(await fsp.readFile(path.join(home, "mcp.json"), "utf8")).mcpServers["wrapped-fixture"];
  assert.equal(wrapped.type, "sse");
  assert.equal(wrapped.headers.Authorization, "Bearer fixture");

  stage = "switching to JSON without edits stays clean, and global inherited server is visible and overridable in project";
  await setField("配置范围", "project");
  await wait(async () => (await panelText()).includes("json-fixture") && (await panelText()).includes("全局继承") && (await panelText()).includes("wrapped-fixture"));
  assert.ok((await panelText()).includes("全局"));
  await clickLabel("配置 json-fixture");
  await wait(async () => (await panelText()).includes("高级配置"));
  assert.equal(await fieldValue("服务器名称"), "json-fixture");
  await clickText("JSON");
  await wait(() => host<boolean>(`!!(${visible}).querySelector('textarea[aria-label="完整配置"]')`));
  assert.equal(JSON.parse(await fieldValue("完整配置"))["json-fixture"].env.MCP_FIXTURE_VALUE, "json");
  await clickLabel("返回列表");
  await wait(async () => (await panelText()).includes("项目服务器"));
  assert.equal(await host("!!document.querySelector('[role=dialog]')"), false);
  // 在项目视图中，点击全局继承的 wrapped-fixture 卡片上的「在项目中覆盖」
  await clickText("在项目中覆盖");
  await wait(async () => (await panelText()).includes("高级配置"));
  assert.equal(await fieldValue("服务器名称"), "wrapped-fixture");
  await clickText("保存");
  await wait(async () => (await panelText()).includes("已保存"));
  // 保存后，项目服务器中有了 wrapped-fixture，全局继承列表中显示「已由项目覆盖」
  await wait(async () => (await panelText()).includes("已由项目覆盖"));
  assert.ok(JSON.parse(await fsp.readFile(mcpFile, "utf8")).mcpServers["wrapped-fixture"]);
  stage = "reopen collapsed sidebar and check layout";
  await host("document.querySelector('[aria-label=\"收起右侧抽屉\"]').click()");
  assert.equal(await host("document.querySelector('.inspect-shell').getBoundingClientRect().width"), 0);
  await host("document.querySelector('[aria-label=\"Skills / MCP\"]').click()");
  await wait(async () => (await panelText()).includes("created-in-sidebar"));
  const overflows = await host<string[]>(`Array.from((${visible}).querySelectorAll('input, textarea, select, .cap-card')).filter(el => el.getBoundingClientRect().right > (${visible}).getBoundingClientRect().right + 1).map(el => el.className)`);
  assert.deepEqual(overflows, []);
  stage = "widen the panel and check two-column cards";
  await host("localStorage.setItem('tacode.inspectWidth', '700')");
  await main!.webContents.executeJavaScript("location.reload()");
  await wait(() => host("!!document.querySelector('[data-project=\"0\"]')"));
  await host("document.querySelector('[aria-label=\"Skills / MCP\"]').click()");
  await wait(async () => (await panelText()).includes("code-review"));
  await screenshot("skills-panel-wide.png");
  const skillColumns = await host<string>(`getComputedStyle(Array.from((${visible}).querySelectorAll('.cap-card-list')).find(el => el.querySelector('.cap-skill-card'))).gridTemplateColumns`);
  assert.equal(skillColumns.trim().split(/\s+/).length, 2);
  await tab("MCP");
  await wait(async () => (await panelText()).includes("Filesystem"));
  await screenshot("mcp-panel-wide.png");
  const wideOverflows = await host<string[]>(`Array.from((${visible}).querySelectorAll('input, textarea, select, .cap-card')).filter(el => el.getBoundingClientRect().right > (${visible}).getBoundingClientRect().right + 1).map(el => el.className)`);
  assert.deepEqual(wideOverflows, []);
  stage = "check the JSON editor in a narrow panel";
  await host("localStorage.setItem('tacode.inspectWidth', '320')");
  await main!.webContents.executeJavaScript("location.reload()");
  await wait(() => host("!!document.querySelector('[data-project=\"0\"]')"));
  await host("document.querySelector('[aria-label=\"Skills / MCP\"]').click()");
  await tab("MCP");
  await wait(async () => (await panelText()).includes("Filesystem"));
  await clickText("添加服务器"); await clickText("JSON");
  assert.ok(await host<boolean>(`!!(${visible}).querySelector('textarea[aria-label="完整配置"]')`));
  const narrowOverflows = await host<string[]>(`Array.from((${visible}).querySelectorAll('input, textarea, select, .cap-card, .cap-editor-tabs, .cap-detail-heading, .cap-detail-meta')).filter(el => el.getBoundingClientRect().right > (${visible}).getBoundingClientRect().right + 1).map(el => el.className)`);
  assert.deepEqual(narrowOverflows, []);
  await screenshot("mcp-json-narrow.png");
  assert.deepEqual(rendererErrors.filter((message) => !message.includes("Electron Security Warning")), []);
  console.log("Capabilities smoke passed: tabs, skill create/edit/toggle/import, unsaved changes, MCP connection/tools/save/toggle/import/remove, MCP editor JSON mode (paste, test, form round-trip, multi-server rejection, global scope), project and global isolation.");
} catch (error) {
  console.error(`Capabilities smoke failed at ${stage}:`, error);
  await screenshot("capabilities-failure.png").catch(() => undefined);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog); main?.destroy();
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(process.exitCode ?? 0);
}
}

void smoke().catch((error) => { console.error(error); app.exit(1); });
