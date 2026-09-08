import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useI18n } from "../i18n";

export type BrowserFindResult = {
  activeMatchOrdinal: number;
  matches: number;
};

export type BrowserFindBarProps = {
  value: string;
  result: BrowserFindResult | null;
  onSearch: (text: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

const formatMatchCount = (value: string, result: BrowserFindResult | null): string => {
  if (!value || !result) return "";
  if (result.matches === 0) return "0/0";
  return `${result.activeMatchOrdinal}/${result.matches}`;
};

/**
 * 页内查找条：覆盖在浏览器内容区右上角，挂载即聚焦；输入驱动
 * webview.findInPage，Enter / Shift+Enter 跳转匹配项，Escape 关闭。
 * 移植自 Snow App（MIT）BrowserFindBar.tsx。
 */
export const BrowserFindBar = ({
  value,
  result,
  onSearch,
  onNext,
  onPrev,
  onClose,
}: BrowserFindBarProps): React.JSX.Element => {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  const matchCount = formatMatchCount(value, result);
  const hasNoMatches = !!value && !!result && result.matches === 0;

  return (
    <div className="browser-find-bar">
      <input
        ref={inputRef}
        type="text"
        className="browser-find-input"
        value={value}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("browser.findPlaceholder")}
        spellCheck={false}
      />
      <span className={`browser-find-count${hasNoMatches ? " is-empty" : ""}`}>{matchCount}</span>
      <button
        type="button"
        className="browser-find-btn"
        onClick={onPrev}
        disabled={!value}
        aria-label={t("browser.findPrev")}
        title={t("browser.findPrev")}
      >
        <ChevronUp size={14} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-find-btn"
        onClick={onNext}
        disabled={!value}
        aria-label={t("browser.findNext")}
        title={t("browser.findNext")}
      >
        <ChevronDown size={14} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="browser-find-btn"
        onClick={onClose}
        aria-label={t("browser.findClose")}
        title={t("browser.findClose")}
      >
        <X size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
};
