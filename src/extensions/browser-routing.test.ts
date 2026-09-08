import { describe, expect, it } from "vitest";
import { browserRoutingBlock, externalBrowserCommand, externalBrowserRequested } from "./browser-routing";

describe("default embedded browser routing", () => {
  it.each([
    "open 'http://localhost:9001/unibest/'",
    '/usr/bin/open "https://example.com"',
    'open -a "Google Chrome" https://example.com',
    "curl -I http://localhost:9001 && open http://localhost:9001/unibest/",
    'xdg-open "https://example.com"',
    "gio open https://example.com",
    'cmd /c start "" "http://localhost:9001/unibest/"',
    'powershell -Command "Start-Process \'http://localhost:9001/unibest/\'"',
    'bash -lc "open http://localhost:9001/unibest/"',
    "python3 -m webbrowser http://localhost:9001/unibest/",
    "BROWSER=chrome pnpm dev:h5 -- --open",
    "npx vite --open=/unibest/",
  ])("redirects the external opener %s", (command) => {
    expect(externalBrowserCommand(command)).toBe(true);
    expect(browserRoutingBlock("exec_command", { cmd: command }, "打开项目web端")).toMatchObject({ block: true });
  });

  it.each([
    "open /tmp/report.pdf", "open -a TextEdit ./README.md", "pnpm dev:h5", "pnpm dev -- --open=false",
    "curl http://localhost:9001/unibest/", 'echo "open https://example.com"',
    "printf '%s' '说明; open https://example.com'", "# open https://example.com\npnpm dev:h5",
    "rg 'open https://example.com' README.md",
  ])("preserves file opening, server startup and quoted documentation: %s", (command) => {
    expect(externalBrowserCommand(command)).toBe(false);
    expect(browserRoutingBlock("exec_command", { cmd: command }, "打开项目web端")).toBeUndefined();
  });

  it.each(["用 Chrome 打开项目页面", "请使用系统默认浏览器打开", "在 Safari 中预览页面", "Open the page in Firefox", "不要用内嵌，而是用 Safari 打开"])("respects an explicit external-browser request: %s", (prompt) => {
    expect(externalBrowserRequested(prompt)).toBe(true);
    expect(browserRoutingBlock("exec_command", { cmd: "open http://localhost:9001" }, prompt)).toBeUndefined();
  });
  it.each(["打开项目web端", "不要用外部浏览器", "不要用 Chrome 打开", "为什么用外部浏览器打开", "打开 Chrome 文档", "Don't use Chrome"])("keeps embedded routing for %s", (prompt) => {
    expect(externalBrowserRequested(prompt)).toBe(false);
    expect(browserRoutingBlock("exec_command", { cmd: "open http://localhost:9001" }, prompt)).toMatchObject({ block: true });
  });
  it("does not intercept the embedded tool itself", () => {
    expect(browserRoutingBlock("browser_navigate", { command: "open http://localhost:9001" }, "打开项目web端")).toBeUndefined();
  });
});
