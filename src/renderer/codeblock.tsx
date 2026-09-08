import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "./i18n";
import { getDisplayName, highlightToTokens, isHighlighterReady, onHighlighterReady, type HighlightTokensResult } from "./shiki";
import { tokenizeCode, type CodeToken } from "./highlight";

/**
 * CodeBlock — 块级代码组件。
 *
 * react-markdown 的 `pre` 自定义渲染入口。用 Shiki `highlightToTokens` 逐行渲染，
 * 高亮器未就绪时按纯文本渲染（继承深底浅字），流式输出不阻塞。
 *
 * 结构（亮暗界面一致：浅色头部栏 + 深色代码屏）：
 * ┌────────────────────────────────────────────┐
 * │ [语言名]                          [📋 复制] │  ← 头部栏（--inset）
 * ├────────────────────────────────────────────┤
 * │  Shiki token 逐行渲染（one-dark-pro）        │  ← 代码区（--code-screen）
 * └────────────────────────────────────────────┘
 */

const THROTTLE_MS = 80;

/** 代码区固定深色高亮（one-dark-pro），不随界面主题切换，与 --code-screen 配套。 */
const CODE_APP_THEME = "dark";

interface CodeBlockProps {
  children: ReactNode;
  /** 最大高度（px），超出滚动；默认 280。 */
  maxHeight?: number;
  className?: string;
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function extractCodeInfo(children: ReactNode): { language: string; code: string } {
  const codeElement = Array.isArray(children)
    ? children.find((child) => {
        if (child == null || typeof child !== "object" || !("type" in (child as object))) return false;
        const t = (child as { type: unknown }).type;
        return t === "code" || typeof t === "function" || typeof t === "object";
      })
    : undefined;
  const props = (codeElement as { props?: CodeElementProps } | undefined)?.props;
  const langMatch = props?.className?.match(/language-(\S+)/);
  return {
    language: langMatch?.[1] ?? "",
    code: extractText(props?.children ?? children),
  };
}

/** Shiki token 已就绪时的逐行渲染。 */
const ShikiLines = memo(function ShikiLines({ tokens, rawLine }: { tokens: { content: string; color?: string }[]; rawLine: string }) {
  const covered = tokens.reduce((sum, token) => sum + token.content.length, 0);
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
      ))}
      {covered < rawLine.length && <span>{rawLine.slice(covered)}</span>}
    </>
  );
});

/** tokenizeCode 未就绪降级（沿用现有 --md-* 的着色类，保证对比度）。 */
const FallbackLines = memo(function FallbackLines({ tokens }: { tokens: CodeToken[] }) {
  return (
    <>
      {tokens.map((token, index) => token.kind
        ? <em key={index} className={token.kind}>{token.text}</em>
        : <span key={index}>{token.text}</span>)}
    </>
  );
});

export function CodeBlock({ children, maxHeight = 280, className }: CodeBlockProps) {
  const { t } = useI18n();
  const { language, code } = useMemo(() => extractCodeInfo(children), [children]);
  const trimmed = code.replace(/\n$/, "");
  const langOrText = language || "text";
  const rawLines = useMemo(() => trimmed.split("\n"), [trimmed]);

  const [tokenResult, setTokenResult] = useState<HighlightTokensResult | null>(() =>
    highlightToTokens(trimmed, langOrText, CODE_APP_THEME));
  const [copied, setCopied] = useState(false);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdateRef = useRef(Date.now());

  // 高亮器未就绪（tokenResult 为 null）：订阅就绪事件，首次出 token。
  // 未就绪期间 ShikiLines 收到空 token，按纯文本渲染，颜色继承 --code-screen-ink。
  useEffect(() => {
    if (tokenResult) return;
    return onHighlighterReady(() =>
      setTokenResult(highlightToTokens(trimmed, langOrText, CODE_APP_THEME)));
  }, [tokenResult, trimmed, langOrText]);

  // 节流刷新：流式输出时重算 token。
  useEffect(() => {
    const now = Date.now();
    const sync = highlightToTokens(trimmed, langOrText, CODE_APP_THEME);
    if (!sync) return;
    const elapsed = now - lastUpdateRef.current;
    if (elapsed >= THROTTLE_MS) {
      lastUpdateRef.current = now;
      setTokenResult(sync);
    } else if (!timeoutRef.current) {
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        lastUpdateRef.current = Date.now();
        const latest = highlightToTokens(trimmed, langOrText, CODE_APP_THEME);
        if (latest) setTokenResult(latest);
      }, THROTTLE_MS - elapsed);
    }
  }, [trimmed, langOrText]);

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [trimmed]);

  return (
    <div className="code-block-wrapper">
      <div className="code-block-bar">
        <span className="code-block-lang">{language ? getDisplayName(language) : t("codeblock.untitled")}</span>
        <button type="button" className="code-block-copy" onClick={handleCopy} aria-label={t("common.copy")}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span>{copied ? t("common.copied") : t("common.copy")}</span>
        </button>
      </div>
      <pre
        className="code-block-body"
        style={{ maxHeight }}
      >
        <code>
          {rawLines.map((rawLine, index) => (
            <span key={index} className="code-line-plain">
              <ShikiLines tokens={tokenResult?.lines[index] ?? []} rawLine={rawLine} />
              {index < rawLines.length - 1 && "\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/**
 * useShikiTokens — 供「读取文件详情」「文件抽屉」复用的 Shiki token hook。
 * 返回按行 token（Shiki 就绪时）或 null（未就绪），调用方用 tokenizeCode 降级。
 * 主题变化 / 高亮器就绪时自动重算。
 */
export function useShikiTokens(code: string, language: string, theme?: string): HighlightTokensResult | null {
  const [result, setResult] = useState<HighlightTokensResult | null>(() =>
    isHighlighterReady() ? highlightToTokens(code, language, theme) : null);

  useEffect(() => {
    if (!isHighlighterReady()) {
      return onHighlighterReady(() => setResult(highlightToTokens(code, language, theme)));
    }
    setResult(highlightToTokens(code, language, theme));
    return undefined;
  }, [code, language, theme]);

  return result;
}

/**
 * HighlightedFileCode — 带行号 gutter 的高亮代码区。
 * Shiki 就绪用逐行 color 渲染，未就绪降级 tokenizeCode 的 em 类着色。
 * 供读取文件详情与文件抽屉复用。
 */
export function HighlightedFileCode({ code, language, lineGutter = true }: {
  code: string;
  language: string;
  lineGutter?: boolean;
}) {
  const theme = useAppThemeLocal();
  const rawLines = useMemo(() => code.split("\n"), [code]);
  const shiki = useShikiTokens(code, language, theme);
  const fallback = useMemo(() => shiki ? null : tokenizeCode(code, language), [shiki, code, language]);

  return (
    <>
      {rawLines.map((rawLine, index) => (
        <span key={index} className="code-line">
          {lineGutter && <i>{index + 1}</i>}
          <span>
            {shiki
              ? <ShikiLines tokens={shiki.lines[index] ?? []} rawLine={rawLine} />
              : <FallbackLines tokens={fallback?.[index] ?? []} />}
          </span>
        </span>
      ))}
    </>
  );
}

/** 读取当前主题（dark → one-dark-pro，其余 → one-light）。 */
function useAppThemeLocal(): string {
  const subscribe = useCallback((notify: () => void) => {
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme ?? "paper", () => "paper");
}

export { ShikiLines, FallbackLines };
