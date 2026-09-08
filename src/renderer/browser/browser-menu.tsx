import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  ChevronRight,
  Code2,
  Cookie,
  EllipsisVertical,
  Eraser,
  Globe,
  Minus,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { useI18n } from "../i18n";

export type BrowserMenuProps = {
  zoomFactor: number;
  homepage: string;
  onClearCache: () => void;
  onClearCookies: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onForceReload: () => void;
  onFindInPage: () => void;
  onOpenDevTools: () => void;
  onSetHomepage: (url: string) => Promise<void>;
  /** 独立窗口专属：还原为浏览器面板标签页（undefined 时菜单不显示该项）。 */
  onRestoreToTabs?: () => void;
  /** 主面板专属：把当前实例弹出为独立窗口（undefined 时菜单不显示该项）。 */
  onOpenInNewWindow?: () => void;
};

type MenuPosition = { top: number; left: number } | null;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const MENU_WIDTH = 200;
const MENU_GAP = 4;
const ESTIMATED_MENU_HEIGHT = 268;
const RESTORE_ITEM_HEIGHT = 36;

const formatZoomPercent = (factor: number): string => `${Math.round(factor * 100)}%`;

/**
 * 浏览器工具栏的「更多操作」下拉菜单。
 *
 * 移植自 Snow App（MIT）BrowserMenu.tsx：经 portal 渲染到 document.body 并用
 * position: fixed，避免被 overflow: hidden 祖先裁剪。包含清除浏览数据
 * （flyout 子菜单）、缩放（inline 行）、默认起始页（inline 编辑）、
 * 强制刷新 / 页内查找 / 开发者工具，以及独立窗口专属的「还原为标签页」。
 */
export const BrowserMenu = ({
  zoomFactor,
  homepage,
  onClearCache,
  onClearCookies,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onForceReload,
  onFindInPage,
  onOpenDevTools,
  onSetHomepage,
  onRestoreToTabs,
  onOpenInNewWindow,
}: BrowserMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [clearDataSubOpen, setClearDataSubOpen] = useState(false);
  const [isHomepageEditing, setIsHomepageEditing] = useState(false);
  const [homepageDraft, setHomepageDraft] = useState(homepage);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const homepageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHomepageDraft(homepage);
  }, [homepage]);

  useEffect(() => {
    if (isHomepageEditing && homepageInputRef.current) {
      homepageInputRef.current.focus();
      homepageInputRef.current.select();
    }
  }, [isHomepageEditing]);

  // 外点 / Escape 关闭。portal 在 document.body 上，必须同时排除
  // 触发器容器与弹出菜单内部的点击。
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      setIsOpen(false);
      setClearDataSubOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsOpen(false);
        setClearDataSubOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  // 定位只依赖 isOpen：依赖其它状态会在渲染中途读到零尺寸 rect 把菜单甩到左上角。
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) {
      setMenuPosition(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight = ESTIMATED_MENU_HEIGHT + (onRestoreToTabs ? RESTORE_ITEM_HEIGHT : 0);
    let left = rect.right - MENU_WIDTH;
    let top = rect.bottom + MENU_GAP;
    if (left < 8) left = 8;
    if (top + estimatedHeight > window.innerHeight) {
      top = Math.max(8, rect.top - MENU_GAP - estimatedHeight);
    }
    setMenuPosition({ top, left });
  }, [isOpen, onRestoreToTabs]);

  const close = useCallback((): void => {
    setIsOpen(false);
    setClearDataSubOpen(false);
    setIsHomepageEditing(false);
  }, []);

  const runAction = useCallback(
    (fn: () => void): void => {
      fn();
      close();
    },
    [close],
  );

  const handleTriggerClick = (): void => {
    setIsOpen((prev) => !prev);
    setClearDataSubOpen(false);
    setIsHomepageEditing(false);
  };

  const handleSaveHomepage = useCallback(async (): Promise<void> => {
    await onSetHomepage(homepageDraft);
    setIsHomepageEditing(false);
  }, [homepageDraft, onSetHomepage]);

  const handleHomepageKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSaveHomepage();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setHomepageDraft(homepage);
      setIsHomepageEditing(false);
    }
  };

  const canZoomIn = zoomFactor < ZOOM_MAX;
  const canZoomOut = zoomFactor > ZOOM_MIN;
  const canZoomReset = zoomFactor !== 1;

  return (
    <div className="browser-menu-wrapper" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`browser-nav-btn browser-menu-trigger${isOpen ? " is-open" : ""}`}
        onClick={handleTriggerClick}
        aria-label={t("browser.moreActions")}
        aria-haspopup="true"
        aria-expanded={isOpen}
        title={t("browser.moreActions")}
      >
        <EllipsisVertical size={15} strokeWidth={1.8} />
      </button>
      {isOpen && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="browser-menu-dropdown"
              style={{ top: menuPosition.top, left: menuPosition.left }}
              role="menu"
            >
              {onOpenInNewWindow && (
                <button
                  type="button"
                  className="browser-menu-item"
                  role="menuitem"
                  onClick={() => runAction(onOpenInNewWindow)}
                >
                  <AppWindow size={14} strokeWidth={1.8} />
                  <span className="browser-menu-label">{t("browser.openInNewWindow")}</span>
                </button>
              )}
              {onRestoreToTabs && (
                <button
                  type="button"
                  className="browser-menu-item"
                  role="menuitem"
                  onClick={() => runAction(onRestoreToTabs)}
                >
                  <PanelLeft size={14} strokeWidth={1.8} />
                  <span className="browser-menu-label">{t("browser.restoreToTabs")}</span>
                </button>
              )}

              <div
                className="browser-menu-submenu"
                onMouseEnter={() => setClearDataSubOpen(true)}
                onMouseLeave={() => setClearDataSubOpen(false)}
              >
                <button
                  type="button"
                  className="browser-menu-item browser-menu-submenu-trigger"
                  role="menuitem"
                  aria-haspopup="true"
                  onClick={() => setClearDataSubOpen((prev) => !prev)}
                >
                  <Eraser size={14} strokeWidth={1.8} />
                  <span className="browser-menu-label">{t("browser.clearBrowsingData")}</span>
                  <ChevronRight size={13} strokeWidth={1.8} className="browser-menu-chevron" />
                </button>
                {clearDataSubOpen && (
                  <div className="browser-menu-flyout" role="menu">
                    <button
                      type="button"
                      className="browser-menu-item"
                      role="menuitem"
                      onClick={() => runAction(onClearCache)}
                    >
                      <Trash2 size={14} strokeWidth={1.8} />
                      <span className="browser-menu-label">{t("browser.clearCache")}</span>
                    </button>
                    <button
                      type="button"
                      className="browser-menu-item"
                      role="menuitem"
                      onClick={() => runAction(onClearCookies)}
                    >
                      <Cookie size={14} strokeWidth={1.8} />
                      <span className="browser-menu-label">{t("browser.clearCookies")}</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="browser-menu-zoom-row">
                <ZoomIn size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">{t("browser.zoom")}</span>
                <button
                  type="button"
                  className="browser-menu-zoom-btn"
                  onClick={onZoomOut}
                  disabled={!canZoomOut}
                  aria-label={t("browser.zoomOut")}
                  title={t("browser.zoomOut")}
                >
                  <Minus size={13} strokeWidth={2.2} />
                </button>
                <button
                  type="button"
                  className="browser-menu-zoom-value"
                  onClick={onZoomReset}
                  disabled={!canZoomReset}
                  title={t("browser.zoomReset")}
                >
                  {formatZoomPercent(zoomFactor)}
                </button>
                <button
                  type="button"
                  className="browser-menu-zoom-btn"
                  onClick={onZoomIn}
                  disabled={!canZoomIn}
                  aria-label={t("browser.zoomIn")}
                  title={t("browser.zoomIn")}
                >
                  <Plus size={13} strokeWidth={2.2} />
                </button>
              </div>

              <div className="browser-menu-homepage-row">
                <Globe size={14} strokeWidth={1.8} />
                {isHomepageEditing ? (
                  <input
                    ref={homepageInputRef}
                    type="text"
                    className="browser-menu-homepage-input"
                    value={homepageDraft}
                    onChange={(e) => setHomepageDraft(e.target.value)}
                    onKeyDown={handleHomepageKeyDown}
                    onBlur={() => void handleSaveHomepage()}
                    placeholder={t("browser.homepagePlaceholder")}
                    spellCheck={false}
                  />
                ) : (
                  <button
                    type="button"
                    className="browser-menu-homepage-display"
                    onClick={() => setIsHomepageEditing(true)}
                    title={t("browser.setHomepage")}
                  >
                    {homepage || t("browser.homepageEmpty")}
                  </button>
                )}
              </div>

              <button type="button" className="browser-menu-item" role="menuitem" onClick={() => runAction(onForceReload)}>
                <RefreshCw size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">{t("browser.forceReload")}</span>
              </button>
              <button type="button" className="browser-menu-item" role="menuitem" onClick={() => runAction(onFindInPage)}>
                <Search size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">{t("browser.findInPage")}</span>
              </button>
              <button type="button" className="browser-menu-item" role="menuitem" onClick={() => runAction(onOpenDevTools)}>
                <Code2 size={14} strokeWidth={1.8} />
                <span className="browser-menu-label">{t("browser.openDevTools")}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
