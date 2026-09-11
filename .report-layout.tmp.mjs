import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electronPath from "electron";

// 只加载 workbench fixture（?chat），打开「进程内委派」标签后量测报告排版。
const root = process.cwd();
console.log("A: cwd", process.cwd());
const output = await mkdtemp(path.join(tmpdir(), "tacode-report-layout-"));
const entry = path.join(output, "probe.mjs");
const fixtureDir = path.join(output, "renderer");
await build({ entry: { probe: "scripts/workbench-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
console.log("B: tsup done, output", output);
await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "error", build: { outDir: fixtureDir, emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/workbench.html" } } });
console.log("C: vite done");
const fixture = path.join(fixtureDir, "scripts/fixtures/workbench.html");

await writeFile(entry, `
import { app, BrowserWindow } from "electron";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const profile = await mkdtemp(path.join(tmpdir(), "tacode-report-profile-"));
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
await app.whenReady();
const preload = path.join(profile, "preload.cjs");
await writeFile(preload, \`require(\${JSON.stringify(path.join(${JSON.stringify(root)}, "dist-electron/preload/index.cjs"))});\\nlocalStorage.setItem('tacode.browserHomepage', JSON.stringify('about:blank'));\`);
const win = new BrowserWindow({ width: 1100, height: 820, show: true, webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false, webviewTag: true } });
await win.loadFile(${JSON.stringify(fixture)}, { query: { chat: "1" } });
const host = (script) => win.webContents.executeJavaScript(script);
const wait = async (script, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await host(script)) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error("timeout: " + label);
};
await wait("!!document.querySelector('[data-fixture-inline-turn] .flow-tool-line')", "tool line");
await host("document.querySelector('[data-fixture-inline-turn] .flow-tool-line').click()");
await wait("!!document.querySelector('[data-fixture-inline-turn] .delegate-task')", "delegate card");
await host("document.querySelector('[data-fixture-inline-turn] .delegate-task').click()");
await wait("!!document.querySelector('.child-session-report')", "report");
const out = await host(\`(() => {
  const all = (sel) => document.querySelectorAll(sel).length;
  const report = document.querySelector('.child-session-report');
  const cs = (el) => getComputedStyle(el);
  const boxes = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
  const wrap = report.querySelector('.md-table-wrap');
  const tight = Array.from(report.querySelectorAll('th.is-tight, td.is-tight'));
  const chipName = report.querySelector('.file-chip-name');
  const code = report.querySelector('p code');
  const table = report.querySelector('table');
  const cells = Array.from(report.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => Math.round(c.getBoundingClientRect().width)));
  const wrapTag = wrap ? wrap.firstElementChild.tagName : null;
  return {
    sidebar: { projectRows: all('.project-row'), sessionRows: all('.session-row') },
    wrapTag,
    wrapOverflow: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
    tightCount: tight.length,
    tightLines: tight.map(boxes),
    tightText: tight.map((el) => el.textContent),
    columnWidths: cells,
    bodyFont: parseFloat(cs(report).fontSize),
    lineHeight: parseFloat(cs(report).lineHeight),
    listIndent: parseFloat(cs(report.querySelector('ul')).paddingLeft),
    listMarker: cs(report.querySelector('ul li')).listStyleType,
    chipFont: chipName ? parseFloat(cs(chipName).fontSize) : null,
    chipText: chipName ? chipName.textContent : null,
    codeFont: code ? parseFloat(cs(code).fontSize) : null,
    codeBg: code ? cs(code).backgroundColor : null,
    codePadding: code ? cs(code).padding : null,
    h2Font: parseFloat(cs(report.querySelector('h2')).fontSize),
    reportWidth: Math.round(report.getBoundingClientRect().width),
    wrapWidth: Math.round(wrap.getBoundingClientRect().width),
    tableWidth: Math.round(table.getBoundingClientRect().width),
  };
})()\`);
await writeFile(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
if (process.env.PROBE_SHOT) await writeFile(process.env.PROBE_SHOT, (await win.webContents.capturePage()).toPNG());
console.log("PROBE_DONE");
app.exit(0);
`);
const { spawn } = await import("node:child_process");
const env = { ...process.env, PROBE_OUT: path.join(output, "layout.json") };
if (process.env.PROBE_SHOT) env.PROBE_SHOT = process.env.PROBE_SHOT;
delete env.ELECTRON_RUN_AS_NODE;
console.log("D: spawning electron");
const code = await new Promise((resolve, reject) => {
  const child = spawn(electronPath, [entry], { env, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (value) => resolve(value ?? 1));
});
process.exitCode = code;
