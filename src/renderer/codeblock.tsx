import { Component, createRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "./i18n";
import { getDisplayName, highlightToTokens, isHighlighterReady, onHighlighterReady, type HighlightTokensResult } from "./shiki";
import { tokenizeCode, type CodeToken } from "./highlight";
import { rememberPosition, restorePosition, type ReadingPosition } from "./reading-position";
import { canHighlightCode } from "./code-budget";
import { useScrollPin } from "./use-follow-scroll";

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

/** 高亮结果的行 token 缺失时的共享空数组：保持引用稳定，让 ShikiLines 的 memo 生效。 */
const EMPTY_LINE_TOKENS: { content: string; color?: string }[] = [];

interface TokenState {
  result: HighlightTokensResult | null;
  /** 产生这份高亮结果时的完整代码文本（判断「追加式变化」用）。 */
  source: string;
}

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
  const { language, code } = useMemo(() => extractCodeInfo(children), [children]);
  const trimmed = code.replace(/\n$/, "");
  return canHighlightCode(trimmed)
    ? <HighlightedCodeBlock maxHeight={maxHeight} className={className}>{children}</HighlightedCodeBlock>
    : <PlainCodeBlock code={trimmed} language={language} maxHeight={maxHeight} />;
}

/** 一个文本节点保留原文，避免为几千行代码创建数万 token 节点。 */
function PlainCodeBlock({ code, language, maxHeight }: { code: string; language: string; maxHeight: number }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  // 流式跟随：内容增长时贴到最新，但用户往上滚过就交给他（见 useScrollPin）。
  const { attach, stick } = useScrollPin();
  const size = useRef(code.length);
  const setBody = useCallback((node: HTMLPreElement | null) => {
    body.current = node;
    const detach = attach(node);
    // React 19 的 ref 清理不会再回调 ref(null)，这里自己把引用一起清掉，避免后续读到已卸载的节点。
    return detach ? () => { body.current = null; detach(); } : undefined;
  }, [attach]);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); } }, [copied]);
  useLayoutEffect(() => {
    if (code.length > size.current) stick(body.current);
    size.current = code.length;
  }, [code, stick]);
  return <div className="code-block-wrapper" data-large-code>
    <div className="code-block-bar">
      <span className="code-block-lang">{language ? getDisplayName(language) : t("codeblock.untitled")} · {t("codeblock.plain")}</span>
      <button type="button" className="code-block-copy" aria-label={t("common.copy")} onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true), () => {}); }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}<span>{t(copied ? "common.copied" : "common.copy")}</span>
      </button>
    </div>
    <pre className="code-block-body" ref={setBody} style={{ maxHeight }}><code>{code}</code></pre>
  </div>;
}

function HighlightedCodeBlock({ children, maxHeight = 280 }: CodeBlockProps) {
  const { t } = useI18n();
  const { language, code } = useMemo(() => extractCodeInfo(children), [children]);
  const trimmed = code.replace(/\n$/, "");
  const langOrText = language || "text";
  const rawLines = useMemo(() => trimmed.split("\n"), [trimmed]);

  const [tokenState, setTokenState] = useState<TokenState>(() => ({
    result: highlightToTokens(trimmed, langOrText, CODE_APP_THEME),
    source: trimmed,
  }));
  const [copied, setCopied] = useState(false);

  const bodyRef = useRef<HTMLPreElement>(null);
  // 流式跟随：代码区有 max-height，最新几行会落在块的内部滚动区之外。
  // 只在「内容在增长」且「用户没有主动滚上去」时跟到底部；用户滚回底部自动恢复跟随。
  const grownTo = useRef(trimmed.length);
  const { attach, stick } = useScrollPin();
  const setBody = useCallback((node: HTMLPreElement | null) => {
    bodyRef.current = node;
    const detach = attach(node);
    // React 19 的 ref 清理不会再回调 ref(null)，这里自己把引用一起清掉，避免后续读到已卸载的节点。
    return detach ? () => { bodyRef.current = null; detach(); } : undefined;
  }, [attach]);

  useLayoutEffect(() => {
    const previous = grownTo.current;
    grownTo.current = trimmed.length;
    if (trimmed.length <= previous) return;
    stick(bodyRef.current);
  }, [trimmed, stick]);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdateRef = useRef(Date.now());
  // 延迟到期的补算要拿「最新一行」，不能拿调度那次渲染捕获的旧文本（否则流式末尾会停在旧高亮）。
  const latestRef = useRef({ text: trimmed, lang: langOrText });
  latestRef.current = { text: trimmed, lang: langOrText };

  // 高亮器未就绪（result 为 null）：订阅就绪事件，首次出 token。
  // 未就绪期间 ShikiLines 收到空 token，按纯文本渲染，颜色继承 --code-screen-ink。
  useEffect(() => {
    if (tokenState.result) return;
    return onHighlighterReady(() =>
      setTokenState({ result: highlightToTokens(trimmed, langOrText, CODE_APP_THEME), source: trimmed }));
  }, [tokenState, trimmed, langOrText]);

  // 节流刷新：流式输出时重算 token。
  // 注意：先判节流再分词——整段代码的 token 化与代码长度成正比，流式期间每帧都算一遍
  // 就等于每帧跑一次高亮器（WASM oniguruma），而节流只限制了 setState。
  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;
    if (elapsed >= THROTTLE_MS) {
      lastUpdateRef.current = now;
      const sync = highlightToTokens(trimmed, langOrText, CODE_APP_THEME);
      if (sync) setTokenState({ result: sync, source: trimmed });
      return;
    }
    if (timeoutRef.current) return;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      lastUpdateRef.current = Date.now();
      const latest = latestRef.current;
      const tokens = highlightToTokens(latest.text, latest.lang, CODE_APP_THEME);
      if (tokens) setTokenState({ result: tokens, source: latest.text });
    }, THROTTLE_MS - elapsed);
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

  // 按行稳定 token 引用：流式期间每 80ms 出一份新高亮结果，整段重渲染会让
  // 未变化的行也跟着重建 span。追加式更新（新文本以旧文本为前缀）下只有尾部
  // 几行在变——文本相同的行复用上一份的行 token 数组，ShikiLines 的 memo
  // 就能跳过它们；非追加式变化（编辑/重渲染整段）则全量取新。
  const stableLinesRef = useRef<{ rawLines: string[]; tokens: ({ content: string; color?: string }[] | null)[] }>({ rawLines: [], tokens: [] });
  const stableLines = useMemo(() => {
    const previous = stableLinesRef.current;
    const previousSource = previous.rawLines.join("\n");
    const appendOnly = previousSource.length <= trimmed.length
      && (previousSource === trimmed || trimmed.startsWith(previousSource));
    const next = rawLines.map((rawLine, index) => {
      if (appendOnly && rawLine === previous.rawLines[index] && previous.tokens[index]) {
        return previous.tokens[index]!;
      }
      return tokenState.result?.lines[index] ?? null;
    });
    stableLinesRef.current = { rawLines, tokens: next };
    return next;
  }, [tokenState, rawLines, trimmed]);

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
        ref={setBody}
        style={{ maxHeight }}
      >
        <code>
          {rawLines.map((rawLine, index) => (
            <span key={index} className="code-line-plain">
              <ShikiLines tokens={stableLines[index] ?? EMPTY_LINE_TOKENS} rawLine={rawLine} />
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
 *
 * 节流：同步分词与代码长度成正比（实测 5k=6ms / 20k=24ms / 50k=59ms / 100k=118ms），
 * 而流式输出期间代码每帧都在变——展开中的 `read_file` 行若每帧整段重算，单帧就会被
 * 拖到几十毫秒。这里与 CodeBlock 一样先判节流再分词；一次性变化（打开文件）仍立即出结果。
 */
const HIGHLIGHT_THROTTLE_MS = 120;

export function useShikiTokens(code: string, language: string, theme?: string): HighlightTokensResult | null {
  const [state, setState] = useState(() => ({ code, language, theme, tokens: isHighlighterReady() ? highlightToTokens(code, language, theme) : null }));
  const latest = useRef({ code, language, theme });
  latest.current = { code, language, theme };
  const lastRun = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const update = () => {
      lastRun.current = Date.now();
      const next = latest.current;
      setState({ ...next, tokens: highlightToTokens(next.code, next.language, next.theme) });
    };
    if (!isHighlighterReady()) return onHighlighterReady(update);
    const elapsed = Date.now() - lastRun.current;
    if (elapsed >= HIGHLIGHT_THROTTLE_MS) update();
    else if (!timer.current) timer.current = setTimeout(() => { timer.current = null; update(); }, HIGHLIGHT_THROTTLE_MS - elapsed);
  }, [code, language, theme]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // 高亮可能稍晚于正文；不能把上一版文件的 token 当作当前文件内容展示。
  return state.code === code && state.language === language && state.theme === theme ? state.tokens : null;
}

/** token 异步就绪也会更换文本节点，在 React 提交前记录选区、提交后恢复。 */
class PreserveFileSelection extends Component<{ children: ReactNode }, object, ReadingPosition | undefined> {
  private root = createRef<HTMLSpanElement>();
  getSnapshotBeforeUpdate(): ReadingPosition | undefined {
    return this.root.current ? rememberPosition(this.root.current) : undefined;
  }
  componentDidUpdate(_props: { children: ReactNode }, _state: object, position: ReadingPosition | undefined): void {
    if (position && this.root.current) restorePosition(this.root.current, position);
  }
  render() { return <span className="file-code-content" ref={this.root}>{this.props.children}</span>; }
}

/**
 * HighlightedFileCode — 带行号 gutter 的高亮代码区。
 * Shiki 就绪用逐行 color 渲染，未就绪降级 tokenizeCode 的 em 类着色。
 * 供读取文件详情与文件抽屉复用。
 *
 * `lineGutter` 只在代码本身没有行号时开启（文件抽屉是原始文件正文）。
 * 读取文件详情传入 `lineGutter={false}`：那里的正文已由 read_file 嵌入真实行号，
 * 再叠一层只会得到「显示序号 + 真实行号」两列数字（曾经出现 93 93 / 99 99 的误读）。
 */
export function HighlightedFileCode({ code, language, lineGutter = true }: {
  code: string;
  language: string;
  lineGutter?: boolean;
}) {
  return canHighlightCode(code)
    ? <FileCodeTokens code={code} language={language} lineGutter={lineGutter} />
    : <PreserveFileSelection><span className="file-code-plain" data-large-code>{code}</span></PreserveFileSelection>;
}

function FileCodeTokens({ code, language, lineGutter }: { code: string; language: string; lineGutter: boolean }) {
  const theme = useAppThemeLocal();
  const rawLines = useMemo(() => code.split("\n"), [code]);
  const shiki = useShikiTokens(code, language, theme);
  const fallback = useMemo(() => shiki ? null : tokenizeCode(code, language), [shiki, code, language]);

  return (
    <PreserveFileSelection>
      {rawLines.map((rawLine, index) => (
        <span key={index} className={lineGutter ? "code-line" : "code-line no-gutter"}>
          {lineGutter && <i>{index + 1}</i>}
          <span>
            {shiki
              ? <ShikiLines tokens={shiki.lines[index] ?? []} rawLine={rawLine} />
              : <FallbackLines tokens={fallback?.[index] ?? []} />}
          </span>
        </span>
      ))}
    </PreserveFileSelection>
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
