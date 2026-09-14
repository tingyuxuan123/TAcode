import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface DropdownSelectProps<T extends string = string> {
  value: T;
  options: Array<DropdownOption<T>>;
  onChange(value: T): void;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
  title?: string;
}

/**
 * TACode 统一的纸墨风自定义下拉选择器（方案 B）。
 * - 完全消除 macOS 原生 select 丑陋的灰白大弹窗与遮挡输入框问题；
 * - 弹出菜单精准贴合在触发器正下方 4px，采用纸面底、发丝边与柔和阴影；
 * - 聚焦时使用自然边框高亮，彻底消除外层悬空粗黑线；
 * - 内置隐藏的标准 select（通过内联 display:none 隐藏，绝不产生双重显示），完美兼容自动化测试与无障碍。
 */
export function DropdownSelect<T extends string = string>({
  value,
  options,
  onChange,
  className,
  "aria-label": ariaLabel,
  disabled,
  title,
}: DropdownSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hiddenSelectRef = useRef<HTMLSelectElement>(null);
  const id = useId();

  const selected = options.find((opt) => opt.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return;
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const estimatedHeight = Math.min(options.length * 32 + 10, 260);
      const showAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      // 面板宽度按内容自适应（至少与触发器同宽），位置由 useLayoutEffect 精确夹回视口。
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));

      setPlacement({
        minWidth: rect.width,
        maxWidth: window.innerWidth - 16,
        left,
        maxHeight: Math.max(120, showAbove ? spaceAbove : spaceBelow),
        ...(showAbove
          ? { bottom: window.innerHeight - rect.top + 4, top: "auto" }
          : { top: rect.bottom + 4, bottom: "auto" }),
      });
    };

    updatePosition();
    const handleOutside = (e: MouseEvent | PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handleOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, options.length]);

  // 下拉面板按内容自适应宽度后再夹回视口内，避免长选项被截断或溢出屏幕。
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const align = () => {
      const rect = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open]);

  return (
    <div className={`dropdown-select ${className ?? ""}`} ref={containerRef}>
      {/* 隐藏的原生 select：承载语义与事件，内联 display:none 确保绝不产生双重显示 */}
      <select
        ref={hiddenSelectRef}
        style={{ display: "none" }}
        value={value}
        aria-label={ariaLabel}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>

      <button
        ref={triggerRef}
        type="button"
        className={`dropdown-select-trigger${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-label={ariaLabel ?? selected?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="dropdown-select-label">{selected?.label ?? value}</span>
        <ChevronDown size={13} className={`dropdown-select-chevron${open ? " is-open" : ""}`} />
      </button>

      {open && placement && createPortal(
        <div
          ref={panelRef}
          id={id}
          className="dropdown-select-panel"
          style={placement}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`dropdown-select-option${isSelected ? " is-selected" : ""}`}
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span className="dropdown-select-option-label">{opt.label}</span>
                {isSelected && <Check size={13} className="dropdown-select-option-check" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
