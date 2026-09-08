import { createContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { useI18n } from "./i18n";

export const PromptToolbarContext = createContext<{ id?: string; hidden: boolean }>({ hidden: false });
export type ToolbarMode = "full" | "icons" | "overflow";

export function toolbarModeForWidth(available: number, full: number, icons: number): ToolbarMode {
  if (available >= Math.ceil(full)) return "full";
  return available >= Math.ceil(icons) ? "icons" : "overflow";
}

/** 按真实控件宽度收缩；控件始终挂载，极窄时在固定位置的弹层内展示。 */
export function PromptToolbar({ children, action, down }: { children: ReactNode; action: ReactNode; down?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<ToolbarMode>("full");
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const hidden = mode === "overflow" && !open;

  useLayoutEffect(() => {
    if (!bar.current || !controls.current) return;
    // 仅克隆无事件的按钮用于测量，不挂载第二套选择器或复制其弹层。
    const probe = document.createElement("div");
    probe.className = "prompt prompt-toolbar-measure";
    probe.setAttribute("aria-hidden", "true");
    probe.inert = true;
    const rows = (["full", "icons"] as const).map((variant) => {
      const row = document.createElement("div");
      row.className = "prompt-bar";
      row.style.width = "max-content";
      const group = document.createElement("div");
      group.className = "prompt-toolbar-controls";
      group.dataset.mode = variant;
      for (const child of controls.current!.children) {
        const trigger = child.matches("button") ? child : child.querySelector("button");
        if (!trigger) continue;
        const button = trigger.cloneNode(true) as HTMLElement;
        if (child === trigger) group.appendChild(button);
        else {
          const wrapper = child.cloneNode(false) as HTMLElement;
          wrapper.appendChild(button);
          group.appendChild(wrapper);
        }
      }
      row.appendChild(group);
      const send = bar.current!.querySelector(":scope > .send");
      if (send) row.appendChild(send.cloneNode(true));
      row.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      probe.appendChild(row);
      return row;
    });
    document.body.appendChild(probe);
    const measure = () => {
      const available = bar.current?.clientWidth ?? 0;
      if (available > 0) setMode(toolbarModeForWidth(available, rows[0].getBoundingClientRect().width, rows[1].getBoundingClientRect().width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar.current);
    rows.forEach((row) => observer.observe(row));
    return () => { observer.disconnect(); probe.remove(); };
  }, [children, action]);

  useEffect(() => { setOpen(false); }, [mode]);
  useLayoutEffect(() => {
    if (!open || mode !== "overflow") return;
    const place = () => {
      const rect = more.current?.getBoundingClientRect();
      const panel = controls.current;
      if (!rect || !panel) return;
      const width = Math.min(260, window.innerWidth - 16);
      const height = panel.scrollHeight || 172;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const useBelow = down ? below >= height || below > above : above < height && below > above;
      setPlacement({
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        ...(useBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      });
    };
    place();
    const outside = (event: Event) => {
      const target = event.target as Element;
      if (controls.current?.contains(target) || more.current?.contains(target)) return;
      if (target.closest?.("[data-toolbar-owner]")?.getAttribute("data-toolbar-owner") === id) return;
      setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as Element;
      // 子选择器的 Portal 先处理自身的 Escape，下一次才关闭更多弹层。
      if (target.closest?.("[data-toolbar-owner]")?.getAttribute("data-toolbar-owner") === id) return;
      event.preventDefault();
      setOpen(false);
      more.current?.focus();
    };
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
  }, [open, mode, down, id]);

  return <div className="prompt-bar" ref={bar} data-mode={mode}>
    <PromptToolbarContext.Provider value={{ id, hidden }}>
      <div className="prompt-toolbar-controls" ref={controls} id={`${id}-controls`}
        data-mode={mode === "overflow" ? "menu" : mode}
        hidden={hidden} style={mode === "overflow" ? placement : undefined}
        role={mode === "overflow" ? "dialog" : "group"} aria-label={t("composer.moreControls")}>
        {children}
      </div>
    </PromptToolbarContext.Provider>
    {mode === "overflow" && <button type="button" className="prompt-more" ref={more}
      title={t("composer.moreControls")} aria-label={t("composer.moreControls")}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-controls`}
      onClick={() => setOpen((was) => !was)}><Ellipsis size={18} /></button>}
    {action}
  </div>;
}
