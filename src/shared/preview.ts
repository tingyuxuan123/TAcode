import { PREVIEW_HOST, PREVIEW_SCHEME } from "./types";

/**
 * 工作区相对路径 → `harness-preview://` URL。
 *
 * 内容由主进程的 preview 协议从工作区读取（图片预览与内置浏览器页面预览共用），
 * 因此页面里的相对资源、storage 都可用，且不需要起静态服务器。
 */
export function workspacePreviewUrl(relativePath: string): string {
  const path = relativePath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}/${path}`;
}
