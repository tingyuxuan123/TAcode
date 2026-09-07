import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Box, Brain, Check, ChevronDown, Search, Server } from "lucide-react";
import { filterModelOptions, type ModelOption } from "../shared/model-selection";
import { effortLabelKey, pickThinkingOptions, reasoningLevelsAvailable } from "../shared/thinking";
import { useI18n } from "./i18n";

function usePickerPopover(down: boolean | undefined, width: number, height: number) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const dropDown = down ? below >= height || below >= above : above < height && below > above;
      const actualWidth = Math.min(width, window.innerWidth - 16);
      setPlacement({
        width: actualWidth,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - actualWidth - 8)),
        maxHeight: Math.max(0, dropDown ? below : above),
        ...(dropDown ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      });
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    place();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, down, width, height]);

  return { open, setOpen, placement, trigger, panel, id, close };
}

export function ModelPicker({ value, fallback, options, onChange, down, disabled }: {
  value: string;
  fallback: string;
  options: ModelOption[];
  onChange(value: string): void;
  down?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const popover = usePickerPopover(down, 340, 380);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const selected = options.find((option) => option.value === value);
  const filtered = filterModelOptions(options, query);
  const activeIndex = Math.max(0, filtered.findIndex((option) => option.value === active));
  const groups = new Map<string, ModelOption[]>();
  for (const option of filtered) {
    const key = option.serviceId ?? "legacy";
    const group = groups.get(key) ?? [];
    group.push(option);
    groups.set(key, group);
  }
  useEffect(() => {
    if (popover.open) popover.panel.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [popover.open, active, query]);
  const choose = (option: ModelOption) => {
    onChange(option.value);
    popover.close();
  };

  return (
    <div className={`combo model-combo${popover.open ? " open" : ""}`}>
      <button ref={popover.trigger} type="button" className="combo-trigger" disabled={disabled}
        aria-label={t("composer.model")} aria-haspopup="listbox" aria-expanded={popover.open}
        aria-controls={popover.open ? popover.id : undefined}
        title={selected ? `${selected.providerName} · ${selected.label}` : fallback}
        onClick={() => { setQuery(""); setActive(value); popover.setOpen(!popover.open); }}>
        <span>{selected?.label || fallback || t("composer.model")}</span><ChevronDown size={12} />
      </button>
      {popover.open && popover.placement && createPortal(
        <div ref={popover.panel} className="model-picker-panel picker-panel" style={popover.placement}>
          <div className="model-picker-search">
            <Search size={16} aria-hidden="true" />
            <input autoFocus value={query} placeholder={t("composer.filterModels")} aria-label={t("composer.filterModels")}
              role="combobox" aria-expanded="true" aria-controls={popover.id} aria-autocomplete="list"
              aria-activedescendant={filtered.length ? `${popover.id}-${activeIndex}` : undefined}
              onChange={(event) => { setQuery(event.target.value); setActive(""); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = Math.max(0, Math.min(filtered.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
                  setActive(filtered[next]?.value ?? "");
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (filtered[activeIndex]) choose(filtered[activeIndex]);
                }
              }} />
          </div>
          <div className="model-picker-list" id={popover.id} role="listbox" aria-label={t("composer.model")}>
            {filtered.length === 0 && <div className="combo-empty">{t("combo.empty")}</div>}
            {[...groups].map(([key, items]) => (
              <div className="model-picker-group" key={key} role="group" aria-label={items[0].providerName}>
                {items[0].providerName && <div className="model-picker-provider"><Server size={15} /><span>{items[0].providerName}</span></div>}
                {items.map((option) => {
                  const index = filtered.indexOf(option);
                  return (
                    <button key={option.value} id={`${popover.id}-${index}`} type="button" role="option"
                      aria-selected={option.value === value} data-active={index === activeIndex} tabIndex={-1}
                      className={`model-picker-item${option.value === value ? " selected" : ""}`}
                      title={option.label} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
                      <Box size={18} className="model-picker-icon" /><span>{option.label}</span>
                      {option.value === value && <Check size={16} className="model-picker-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>, document.body,
      )}
    </div>
  );
}

export function EffortPicker({ value, levels, onChange, down }: {
  value: string;
  levels: string[];
  onChange(value: string): void;
  down?: boolean;
}) {
  const { t, locale } = useI18n();
  const popover = usePickerPopover(down, 320, 136);
  const options = pickThinkingOptions(levels);
  const index = Math.max(0, options.indexOf(value));
  const label = t(effortLabelKey(options[index] ?? value));
  if (!reasoningLevelsAvailable(levels)) return null;
  return (
    <div className={`effort-picker${popover.open ? " open" : ""}`}>
      <button ref={popover.trigger} type="button" lang={locale} className={`effort-trigger${value === "off" ? " off" : ""}`}
        aria-label={`${t("composer.effort")}：${label}`} title={`${t("composer.effort")}：${label}`}
        aria-haspopup="dialog" aria-expanded={popover.open} aria-controls={popover.open ? popover.id : undefined}
        onClick={() => popover.setOpen(!popover.open)}><Brain size={18} /><span>{label}</span></button>
      {popover.open && popover.placement && createPortal(
        <div ref={popover.panel} id={popover.id} className="effort-picker-panel picker-panel" role="dialog"
          aria-label={t("composer.effort")} style={popover.placement}>
          <div className="effort-picker-heading"><strong>{t("composer.effort")}</strong><span>{label}</span></div>
          <input autoFocus className="effort-slider" type="range" min={0} max={Math.max(0, options.length - 1)} step={1}
            value={index} disabled={options.length < 2} aria-label={t("composer.effort")} aria-valuetext={label}
            style={{ "--effort-progress": `${options.length > 1 ? index / (options.length - 1) * 100 : 100}%` } as CSSProperties}
            onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
            onChange={(event) => { const next = options[Number(event.target.value)]; if (next) onChange(next); }} />
          <div className="effort-picker-labels" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
            {options.map((level) => <button key={level} type="button" aria-pressed={level === value}
              title={level} onClick={() => onChange(level)}>{t(effortLabelKey(level))}</button>)}
          </div>
        </div>, document.body,
      )}
    </div>
  );
}
