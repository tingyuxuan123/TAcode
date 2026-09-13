import os from "node:os";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { CapabilityScope } from "../shared/capabilities";
import type { McpServerRow } from "../shared/integrations";
import { validateMcpServer } from "../shared/mcp-config";
import { mcpConfigPath } from "../runtime/capability-config";
import { getTacodeHome } from "../runtime/home";
import { testMcpServer } from "../runtime/mcp-client";
import { requireString } from "./ipc-validation";
import { SkillsManager } from "./skills-manager";
import { McpManager } from "./mcp-manager";

interface CapabilitiesIpcOptions {
  resolveWorkspace(cwd: string): Promise<string>;
  resolveProjectFile(file: string, cwd: string): Promise<string>;
  changed(cwd?: string): void;
}

export function registerCapabilitiesIpc(options: CapabilitiesIpcOptions): void {
  const skills = new SkillsManager();
  const mcp = new McpManager();
  const workspace = async (raw: unknown): Promise<string | undefined> => raw === undefined ? undefined
    : options.resolveWorkspace(requireString(raw, "项目路径", { maxLength: 4_096 }));
  const scopeOf = (raw: unknown): CapabilityScope => {
    if (raw !== "project" && raw !== "user") throw new Error("请选择当前项目或全局");
    return raw;
  };
  const scoped = async (rawScope: unknown, rawCwd: unknown) => {
    const scope = scopeOf(rawScope);
    const cwd = await workspace(rawCwd);
    if (scope === "project" && !cwd) throw new Error("请先选择项目");
    if (scope === "project") await options.resolveProjectFile(".tacode/mcp.json", cwd!);
    return { scope, cwd };
  };
  const text = (raw: unknown, label = "技能内容") => requireString(raw, label, { allowEmpty: true, maxLength: 1_000_000 });
  const idOf = (raw: unknown) => requireString(raw, "技能标识", { maxLength: 4_096 });

  ipcMain.handle("capabilities:trust-project", async (_event, rawCwd: unknown) => {
    const cwd = await workspace(rawCwd);
    if (!cwd) throw new Error("请先选择项目");
    new ProjectTrustStore(getTacodeHome()).set(cwd, true);
    options.changed(cwd);
  });
  ipcMain.handle("skills:list", async (_event, cwd?: unknown) => skills.list(await workspace(cwd)));
  ipcMain.handle("skills:read", async (_event, id: unknown, cwd?: unknown) => skills.read(idOf(id), await workspace(cwd)));
  ipcMain.handle("skills:create", async (_event, content: unknown, rawScope: unknown, rawCwd?: unknown) => {
    const cwd = await workspace(rawCwd);
    const scope = scopeOf(rawScope);
    const result = await skills.create(text(content), scope, cwd);
    options.changed(scope === "project" ? cwd : undefined);
    return result;
  });
  ipcMain.handle("skills:save", async (_event, id: unknown, content: unknown, previous: unknown, rawCwd?: unknown) => {
    const cwd = await workspace(rawCwd);
    const result = await skills.save(idOf(id), text(content), text(previous), cwd);
    options.changed(result.scope === "project" ? cwd : undefined);
    return result;
  });
  ipcMain.handle("skills:set-enabled", async (_event, id: unknown, enabled: boolean, rawCwd?: unknown) => {
    const cwd = await workspace(rawCwd);
    const result = await skills.setEnabled(idOf(id), enabled, cwd);
    options.changed(result.scope === "project" ? cwd : undefined);
    return result;
  });
  ipcMain.handle("skills:remove", async (_event, id: unknown, rawCwd?: unknown) => {
    const cwd = await workspace(rawCwd);
    await skills.remove(idOf(id), (directory) => shell.trashItem(directory), cwd);
    options.changed();
  });
  ipcMain.handle("skills:reveal", async (_event, id: unknown, rawCwd?: unknown) => {
    const directory = await skills.directory(idOf(id), await workspace(rawCwd));
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  ipcMain.handle("skills:import", async (event, rawScope: unknown, rawCwd?: unknown) => {
    const scope = scopeOf(rawScope);
    const cwd = await workspace(rawCwd);
    if (scope === "project" && !cwd) throw new Error("请先选择项目");
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = { title: "导入 Skills", buttonLabel: "导入", properties: ["openDirectory"], message: "选择含 SKILL.md 的技能目录，也可以选择包含多个技能的文件夹。已有同名技能会跳过。" };
    const selection = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (selection.canceled || !selection.filePaths[0]) return null;
    const result = await skills.importDirectory(selection.filePaths[0], scope, cwd);
    if (result.imported.length) options.changed(scope === "project" ? cwd : undefined);
    return result;
  });
  ipcMain.handle("skills:read-file", async (_event, id: unknown, file: unknown, rawCwd?: unknown) =>
    skills.readFile(idOf(id), requireString(file, "文件路径", { maxLength: 4_096 }), await workspace(rawCwd)));
  ipcMain.handle("skills:save-file", async (_event, id: unknown, file: unknown, content: unknown, previous: unknown, rawCwd?: unknown) => {
    const cwd = await workspace(rawCwd);
    await skills.saveFile(idOf(id), requireString(file, "文件路径", { maxLength: 4_096 }), text(content), text(previous), cwd);
    options.changed();
  });
  ipcMain.handle("mcp:list", async (_event, rawScope: unknown, rawCwd?: unknown) => {
    const { scope, cwd } = await scoped(rawScope, rawCwd);
    return mcp.list(scope, cwd);
  });
  ipcMain.handle("mcp:save", async (_event, server: McpServerRow, previous: unknown, rawScope: unknown, rawCwd?: unknown) => {
    const { scope, cwd } = await scoped(rawScope, rawCwd);
    await mcp.save(server, previous === undefined ? undefined : requireString(previous, "服务器名称", { maxLength: 100 }), scope, cwd);
    options.changed(scope === "project" ? cwd : undefined);
  });
  ipcMain.handle("mcp:set-enabled", async (_event, name: unknown, enabled: boolean, rawScope: unknown, rawCwd?: unknown) => {
    const { scope, cwd } = await scoped(rawScope, rawCwd);
    await mcp.setEnabled(requireString(name, "服务器名称", { maxLength: 100 }), enabled, scope, cwd);
    options.changed(scope === "project" ? cwd : undefined);
  });
  ipcMain.handle("mcp:remove", async (_event, name: unknown, rawScope: unknown, rawCwd?: unknown) => {
    const { scope, cwd } = await scoped(rawScope, rawCwd);
    await mcp.remove(requireString(name, "服务器名称", { maxLength: 100 }), scope, cwd);
    options.changed(scope === "project" ? cwd : undefined);
  });
  ipcMain.handle("mcp:import", async (_event, json: unknown, rawScope: unknown, rawCwd?: unknown) => {
    const { scope, cwd } = await scoped(rawScope, rawCwd);
    const count = await mcp.import(text(json, "JSON 配置"), scope, cwd);
    options.changed(scope === "project" ? cwd : undefined);
    return count;
  });
  ipcMain.handle("mcp:test", async (_event, input: unknown, rawCwd?: unknown) => {
    const cwd = await workspace(rawCwd);
    return testMcpServer(validateMcpServer(input), cwd ?? os.homedir());
  });
  ipcMain.handle("mcp:reveal", async (_event, rawScope: unknown, rawCwd?: unknown) => {
    const { scope, cwd } = await scoped(rawScope, rawCwd);
    shell.showItemInFolder(mcpConfigPath(scope, cwd));
  });
}
