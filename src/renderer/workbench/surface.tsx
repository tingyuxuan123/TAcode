import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { WorkbenchColorScheme } from "./types";
import "./workbench.css";

export function WorkbenchSurface({ toolbar, navigation, children, context, treeOpen, colorScheme = "light", initialTreeWidth = 352, onTreeWidthChange, kind = "file" }: {
  toolbar: ReactNode;
  navigation: ReactNode;
  children: ReactNode;
  context?: ReactNode;
  treeOpen: boolean;
  colorScheme?: WorkbenchColorScheme;
  initialTreeWidth?: number;
  onTreeWidthChange?(width: number): void;
  kind?: "file" | "review";
}) {
  const { t } = useI18n();
  const [treeWidth, setTreeWidth] = useState(initialTreeWidth);
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: number; startX: number; width: number } | null>(null);
  const resize = (width: number) => {
    const available = root.current?.clientWidth ?? 836;
    const next = Math.round(Math.max(200, Math.min(Math.max(200, available - 260), width)));
    setTreeWidth(next);
    onTreeWidthChange?.(next);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || dragging.current.id !== event.pointerId) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <section className={`code-workbench is-${kind}${treeOpen ? " is-tree-open" : ""}`} data-color-scheme={colorScheme}
    style={{ "--workbench-tree-width": treeWidth + "px" } as CSSProperties} ref={root}>
    <header className="workbench-toolbar">{toolbar}</header>
    {context}
    <div className="workbench-body">
      <main className="workbench-content">{children}</main>
      {treeOpen && <>
        <div className="workbench-divider" role="separator" aria-label={t("workbench.resizeTree")} aria-orientation="vertical"
          aria-valuemin={200} aria-valuemax={Math.max(200, (root.current?.clientWidth ?? 836) - 260)} aria-valuenow={treeWidth} tabIndex={0}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); dragging.current = { id: event.pointerId, startX: event.clientX, width: treeWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { const drag = dragging.current; if (drag?.id === event.pointerId) resize(drag.width + drag.startX - event.clientX); }}
          onPointerUp={finish} onPointerCancel={finish}
          onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(treeWidth + (event.key === "ArrowLeft" ? 16 : -16)); } }} />
        <aside className="workbench-navigation">{navigation}</aside>
      </>}
    </div>
  </section>;
}
