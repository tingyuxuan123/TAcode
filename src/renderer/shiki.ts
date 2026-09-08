import { createHighlighter, bundledLanguages } from "shiki";
import type { HighlighterGeneric, BundledLanguage, BundledTheme } from "shiki";

/**
 * Shiki 语法高亮服务（Tether 适配版）。
 *
 * 懒加载的高亮器单例 + 就绪订阅。纯逻辑层，不依赖 React。
 *
 * 三套语义与 Proma 对齐：
 * - 主题按应用主题两档：dark → one-dark-pro，light → one-light。
 * - highlightToTokens() 同步返回逐行 {content,color}（流式/React 逐行渲染最优）。
 * - 未就绪返回 null，由调用方降级到 tokenizeCode 兜底。
 */

type ShikiHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

/** 预加载的语言：覆盖项目正文与读取文件最常见语言，控制 bundle 体积。 */
const DEFAULT_LANGS: BundledLanguage[] = [
  "javascript", "typescript", "python", "java", "json",
  "markdown", "html", "css", "shellscript", "bash", "go", "rust", "sql",
  "tsx", "jsx", "yaml", "toml", "c", "cpp", "csharp", "ruby", "php", "xml",
];

/** 只加载 light/dark 两档主题，避免全量主题 blob。 */
const LIGHT_THEME: BundledTheme = "one-light";
const DARK_THEME: BundledTheme = "one-dark-pro";

export type ShikiTheme = "dark" | "light";

/** 语言别名 → Shiki 规范名。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  yml: "yaml",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  rs: "rust",
  md: "markdown",
  tf: "terraform",
  dockerfile: "docker",
  plaintext: "text",
  txt: "text",
  plain: "text",
};

/** 语言显示名（未匹配则首字母大写）。 */
const DISPLAY_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript",
  tsx: "TSX", jsx: "JSX",
  py: "Python", rb: "Ruby",
  cpp: "C++", "c++": "C++",
  cs: "C#", csharp: "C#",
  kt: "Kotlin", rs: "Rust",
  sh: "Shell", shellscript: "Shell", bash: "Shell", zsh: "Shell",
  yml: "YAML", yaml: "YAML", md: "Markdown", markdown: "Markdown",
  tf: "Terraform", html: "HTML", css: "CSS", scss: "SCSS", less: "LESS",
  json: "JSON", xml: "XML", sql: "SQL", go: "Go", rust: "Rust",
  graphql: "GraphQL", php: "PHP", text: "文本", plaintext: "文本",
};

export function getDisplayName(lang: string): string {
  if (!lang) return "Code";
  const key = lang.toLowerCase();
  return DISPLAY_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** 单行高亮 token。 */
export interface HighlightToken {
  content: string;
  color?: string;
}

/** 按行组织的 token 结果。 */
export interface HighlightTokensResult {
  lines: HighlightToken[][];
  bgColor: string;
  fgColor: string;
  language: string;
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
let cachedHighlighter: ShikiHighlighter | null = null;

const readyListeners = new Set<() => void>();

export function isHighlighterReady(): boolean {
  return cachedHighlighter !== null;
}

/** 订阅高亮器就绪；已就绪立即同步触发。返回 unsubscribe。 */
export function onHighlighterReady(callback: () => void): () => void {
  if (cachedHighlighter) {
    callback();
    return () => {};
  }
  readyListeners.add(callback);
  void getHighlighter();
  return () => readyListeners.delete(callback);
}

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: DEFAULT_LANGS,
    }).then((hl) => {
      cachedHighlighter = hl;
      const listeners = Array.from(readyListeners);
      readyListeners.clear();
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("[shiki] ready listener 抛错:", error);
        }
      }
      return hl;
    }).catch((error) => {
      console.error("[shiki] 初始化失败:", error);
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

/** 解析语言别名并校验是否已加载；无效/未加载回退 text。 */
function resolveLoadedLanguage(highlighter: ShikiHighlighter, lang: string): string {
  const normalized = (lang || "").toLowerCase().trim();
  const resolved = LANGUAGE_ALIASES[normalized] ?? normalized;
  if (resolved === "text") return "text";
  if (resolved in bundledLanguages) {
    return highlighter.getLoadedLanguages().includes(resolved) ? resolved : "text";
  }
  return "text";
}

/** 按需加载语言后返回规范名；失败回退 text。 */
async function resolveAndLoadLanguage(highlighter: ShikiHighlighter, lang: string): Promise<string> {
  const normalized = (lang || "").toLowerCase().trim();
  const resolved = LANGUAGE_ALIASES[normalized] ?? normalized;
  if (resolved === "text") return "text";
  if (highlighter.getLoadedLanguages().includes(resolved)) return resolved;
  try {
    await highlighter.loadLanguage(resolved as BundledLanguage);
    return resolved;
  } catch {
    return "text";
  }
}

/** 应用当前主题 → Shiki 主题名。 */
export function shikiThemeFor(appTheme: unknown): BundledTheme {
  return appTheme === "dark" ? DARK_THEME : LIGHT_THEME;
}

/**
 * 同步高亮代码，返回逐行 token。
 * 高亮器未就绪或语言未适配时返回 null（调用方降级）。
 */
export function highlightToTokens(code: string, language: string, appTheme?: unknown): HighlightTokensResult | null {
  if (!cachedHighlighter) return null;
  const lang = resolveLoadedLanguage(cachedHighlighter, language);
  const theme = shikiThemeFor(appTheme);
  const result = cachedHighlighter.codeToTokens(code, {
    lang: lang as BundledLanguage,
    theme,
  });
  return {
    lines: result.tokens.map((line) =>
      line.map((token) => ({ content: token.content, color: token.color })),
    ),
    bgColor: result.bg ?? (theme === DARK_THEME ? "#282c34" : "#f6f4f0"),
    fgColor: result.fg ?? (theme === DARK_THEME ? "#d7dae0" : "#1c1917"),
    language: lang,
  };
}

/**
 * 异步高亮（服务端/初始化路径），返回 HTML 字符串。
 * 首次会初始化高亮器并按需加载语言。
 */
export async function highlightCode(code: string, language: string, appTheme?: unknown): Promise<string> {
  const highlighter = await getHighlighter();
  const resolved = await resolveAndLoadLanguage(highlighter, language);
  return highlighter.codeToHtml(code, {
    lang: resolved as BundledLanguage,
    theme: shikiThemeFor(appTheme),
  });
}
