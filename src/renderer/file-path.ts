/**
 * 文件路径识别（纯逻辑，与 React 解耦，便于确定性测试）。
 *
 * 判断行内 code 文本是否为「文件路径」，决定渲染成文件 chip 还是普通强调 code。
 * 规则参考 Proma（file-path-chip-utils），但 Tether 无主进程存在性校验，仅按格式与扩展名判定。
 */

const PATH_SEP_RE = /[\\/]/
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/
const UNC_PATH_RE = /^\\\\/

/** 已知可预览/常见源码扩展名，命中才把不含分隔符的裸文件名当文件。 */
const FILE_EXTS = new Set([
  "md", "markdown", "mdx",
  "json", "jsonc", "json5",
  "xml", "html", "htm",
  "txt", "log", "csv", "tsv",
  "yaml", "yml", "toml", "ini", "env", "lock",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "kt", "swift", "rb", "php",
  "c", "h", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish",
  "css", "scss", "less",
  "sql", "diff", "patch",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "pdf", "docx",
]);

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function getFileName(filePath: string): string {
  const parts = filePath.split(PATH_SEP_RE);
  return parts[parts.length - 1] || filePath;
}

/** 剥离末尾 `:12` / `:12:3` 行号后缀。 */
export function stripLineCol(filePath: string): { path: string; suffix: string } {
  const match = filePath.match(/^(.+?)(:\d+(?::\d+)?)$/);
  if (match && !match[1]!.endsWith(":")) {
    return { path: match[1]!, suffix: match[2]! };
  }
  return { path: filePath, suffix: "" };
}

/** 绝对路径：/... 、C:\... 、\\server\share。 */
export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const { path: clean } = stripLineCol(trimmed);
  if (clean.startsWith("/")) {
    if (!/^\/[^\n]+\/[^\n]+$/.test(clean)) return false;
    if (clean.endsWith("/") && !clean.includes(".")) return false;
    return true;
  }
  return UNC_PATH_RE.test(clean) || WIN_DRIVE_RE.test(clean);
}

/** 相对路径：含目录分隔符 + 已知文件扩展名，或裸文件名命中扩展名。 */
export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const { path: clean } = stripLineCol(trimmed);
  const ext = getExtension(clean);
  if (!ext || !FILE_EXTS.has(ext)) return false;
  if (!/^[\w./@\\-]+$/.test(clean)) return false;
  if (clean.startsWith(".") && !PATH_SEP_RE.test(clean)) return false;
  return true;
}

/** 综合判定：是否应为文件 chip。 */
export function isFilePath(text: string): boolean {
  return isAbsoluteFilePath(text) || isRelativeFilePath(text);
}
