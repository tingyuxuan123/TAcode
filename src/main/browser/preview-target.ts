import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePreviewUrl } from "../../shared/preview";

/**
 * 内置浏览器的本地文件预览解析（对齐 PI-Desktop 的 work-panel browser：支持直接打开
 * 工作区里的 HTML 文件，无需启动静态服务器）。
 *
 * 与 PI-Desktop 的差别在承载方式：它用主进程 WebContentsView 直接 loadURL(file://)；
 * TACode 的页面在渲染进程 webview 里，file:// 会被 Chromium 拦成 “Not allowed to load
 * local resource”，因此这里改写成既有的 `harness-preview://` 特权协议 URL——协议处理器
 * 会再次校验路径位于工作区内，相对资源、storage 与 iframe 都能正常工作。
 */

export interface WorkspacePreviewTarget {
  /** 磁盘上的真实文件路径。 */
  file: string;
  /** 交给 webview 加载的 `harness-preview://` URL。 */
  url: string;
}

const inside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + path.sep);

function rootOf(root: string | undefined): { lexical: string; real: string } | undefined {
  const trimmed = root?.trim();
  if (!trimmed) return undefined;
  const lexical = path.resolve(trimmed);
  try {
    const real = fs.realpathSync(lexical);
    return fs.statSync(real).isDirectory() ? { lexical, real } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `explicit` 为 true 表示调用方明确把它当作文件路径（browser_navigate 的 path 参数），
 * 此时相对路径一律按工作区解析；否则（url 参数）只在输入“看起来像文件”时才按文件解析，
 * 让 `example.com`、`localhost:3000` 这类输入继续走 URL/搜索逻辑。
 */
export function resolveWorkspacePreview(
  input: unknown,
  root: string | undefined,
  options: { explicit?: boolean } = {},
): WorkspacePreviewTarget | undefined {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return undefined;
  const rootPaths = rootOf(root);
  if (!rootPaths) return undefined;

  let candidate: string | undefined;
  if (/^file:/i.test(raw)) {
    try {
      candidate = fileURLToPath(raw);
    } catch {
      return undefined;
    }
  } else if (path.isAbsolute(raw)) {
    candidate = raw;
  } else if (options.explicit || /^\.{1,2}[\\/]/.test(raw) || /\.[a-zA-Z0-9]+$/.test(raw)) {
    candidate = path.resolve(rootPaths.lexical, raw);
  }
  if (!candidate) return undefined;

  // 第一道：词法校验拦掉 ../ 与绝对路径逃逸（root 自身可能是符号链接，如 macOS 的 /var）。
  if (!inside(rootPaths.lexical, path.resolve(candidate))) return undefined;
  // 第二道：按真实路径复查，符号链接（工作区里的 link → ~/.ssh）只靠词法判断拦不住。
  let real: string;
  try {
    real = fs.realpathSync(candidate);
    if (!fs.statSync(real).isFile()) return undefined;
  } catch {
    return undefined;
  }
  if (!inside(rootPaths.real, real)) return undefined;
  const relative = path.relative(rootPaths.real, real).split(path.sep).join("/");
  if (!relative) return undefined;
  return { file: real, url: workspacePreviewUrl(relative) };
}
