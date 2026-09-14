import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, Search } from "lucide-react";
import { useI18n } from "../i18n";
import { isImeKey } from "../ime";
import { WorkbenchFileSymbol } from "./file-symbol";
import { ancestorPaths, visibleTreeRows, type WorkbenchTreeRow } from "./tree-model";
import type { WorkbenchChange, WorkbenchTreeEntry } from "./types";

const letters: Record<WorkbenchChange, string> = { added: "A", modified: "•", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };
const rowHeight = 28;

export function WorkbenchFileTree({ entries, selectedPath, query = "", onQueryChange, onOpen, onDoubleOpen, onExpand, initialExpanded = [], initialScroll, restoreReady = true, onScrollChange, onExpandedChange, reveal, label, review = false }: {
  entries: readonly WorkbenchTreeEntry[];
  selectedPath?: string;
  query?: string;
  onQueryChange(query: string): void;
  onOpen(path: string): void;
  onDoubleOpen?(path: string): void;
  onExpand?(path: string): void;
  initialExpanded?: readonly string[];
  label?: string;
  review?: boolean;
  initialScroll?: number;
  restoreReady?: boolean;
  onScrollChange?(top: number): void;
  onExpandedChange?(paths: string[]): void;
  reveal?: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => new Set([...initialExpanded, ...ancestorPaths(selectedPath ?? "")]));
  const expansionDefaults = useRef(new Set(initialExpanded));
  const [focused, setFocused] = useState(selectedPath ?? "");
  const list = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ start: 0, count: 40 });
  const root = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef(initialScroll === undefined ? selectedPath : undefined);
  const pendingScroll = useRef(initialScroll);
  const initialSelection = useRef(true);
  const rows = useMemo(() => visibleTreeRows(entries, expanded, query), [entries, expanded, query]);
  const measure = () => {
    const element = list.current;
    if (!element) return;
    const start = Math.max(0, Math.floor(element.scrollTop / rowHeight) - 6);
    const count = Math.ceil(element.clientHeight / rowHeight) + 12;
    setViewport((current) => current.start === start && current.count === count ? current : { start, count });
  };
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    let frame = 0;
    // Fixed-height rows need only a viewport measurement. Defer resize reactions
    // outside ResizeObserver delivery so writes cannot create an observer loop.
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(element);
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useLayoutEffect(measure, [rows]);
  useLayoutEffect(() => {
    if (!selectedPath) return;
    if (!initialSelection.current && reveal !== undefined) { pendingReveal.current = selectedPath; pendingScroll.current = undefined; }
    initialSelection.current = false;
    for (const parent of ancestorPaths(selectedPath)) onExpand?.(parent);
    setExpanded((current) => {
      const parents = ancestorPaths(selectedPath);
      if (parents.every((path) => current.has(path))) return current;
      return new Set([...current, ...parents]);
    });
  }, [selectedPath, reveal]);
  useLayoutEffect(() => {
    if (pendingScroll.current !== undefined && restoreReady && rows.length && list.current?.clientHeight) {
      list.current.scrollTop = pendingScroll.current; pendingScroll.current = undefined; measure();
    }
    if (!pendingReveal.current || !list.current?.clientHeight) return;
    const index = rows.findIndex((row) => row.path === pendingReveal.current);
    if (index < 0) return;
    const element = list.current; const top = index * rowHeight;
    if (top < element.scrollTop || top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    pendingReveal.current = undefined; measure();
  }, [rows, reveal, restoreReady, viewport.count]);
  useEffect(() => { onExpandedChange?.([...expanded]); }, [expanded, onExpandedChange]);
  useEffect(() => {
    // Git/files arrive asynchronously. Expand newly discovered default paths,
    // while preserving folders the user has already deliberately collapsed.
    const added = initialExpanded.filter((path) => !expansionDefaults.current.has(path));
    expansionDefaults.current = new Set(initialExpanded);
    if (added.length) setExpanded((current) => new Set([...current, ...added]));
  }, [initialExpanded]);

  const toggle = (row: WorkbenchTreeRow) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(row.path)) next.delete(row.path); else next.add(row.path);
      return next;
    });
    onExpand?.(row.path);
  };
  const focusRow = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setFocused(row.path);
    const element = list.current;
    if (element) {
      const top = Math.max(0, Math.min(rows.length - 1, index)) * rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
      measure();
    }
    requestAnimationFrame(() => {
      const nodes = root.current?.querySelectorAll<HTMLElement>("[data-tree-path]");
      [...(nodes ?? [])].find((node) => node.dataset.treePath === row.path)?.focus();
    });
  };
  const onKeyDown = (event: KeyboardEvent, row: WorkbenchTreeRow, index: number) => {
    if (isImeKey(event.nativeEvent)) return;
    if (event.key === "ArrowDown") focusRow(index + 1);
    else if (event.key === "ArrowUp") focusRow(index - 1);
    else if (event.key === "Home") focusRow(0);
    else if (event.key === "End") focusRow(rows.length - 1);
    else if (event.key === "ArrowRight") {
      if (row.kind === "directory") {
        onExpand?.(row.path);
        if (!row.expanded) toggle(row);
        else if (rows[index + 1]?.parent === row.path) focusRow(index + 1);
      }
    } else if (event.key === "ArrowLeft") {
      if (row.kind === "directory" && row.expanded) toggle(row);
      else focusRow(rows.findIndex((item) => item.path === row.parent));
    } else if (event.key === "Enter" || event.key === " ") {
      if (row.kind === "directory") toggle(row); else onOpen(row.path);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const tabPath = rows.some((row) => row.path === focused) ? focused : rows[0]?.path;
  const start = Math.min(viewport.start, Math.max(0, rows.length - 1));
  const visible = rows.slice(start, start + viewport.count);
  return <div className={`workbench-file-tree${review ? " is-review" : ""}`} ref={root}>
    <label className="workbench-file-filter">
      <Search size={14} strokeWidth={1.8} aria-hidden="true" />
      <input type="search" value={query} placeholder={t("workbench.filterFiles")} aria-label={t("workbench.filterFiles")}
        onChange={(event) => onQueryChange(event.target.value)} />
    </label>
    <div className="workbench-tree-content" role="tree" aria-label={label ?? t("workbench.files")}>
      {rows.length === 0 && <p className="workbench-empty">{t("workbench.emptyFiles")}</p>}
      <div ref={list} className="workbench-tree-list" onScroll={() => { measure(); onScrollChange?.(list.current?.scrollTop ?? 0); }}>
        <div style={{ height: rows.length * rowHeight, position: "relative" }}>
          <div style={{ position: "absolute", insetInline: 0, top: start * rowHeight }}>
          {visible.map((row, offset) => <div key={row.path} role="treeitem" aria-level={row.depth + 1}
            aria-selected={selectedPath === row.path} aria-expanded={row.kind === "directory" ? row.expanded : undefined}
            tabIndex={tabPath === row.path ? 0 : -1} data-tree-path={row.path}
            className={`workbench-tree-row${selectedPath === row.path ? " is-selected" : ""}${row.kind === "directory" ? " is-directory" : ""}`}
            style={{ paddingInlineStart: 8 + row.depth * 16 }}
            title={row.path} onFocus={() => setFocused(row.path)}
            onDoubleClick={() => { if (row.kind !== "directory") onDoubleOpen?.(row.path); }}
            onKeyDown={(event) => onKeyDown(event, row, start + offset)}
            onClick={() => { setFocused(row.path); if (row.kind === "directory") toggle(row); else onOpen(row.path); }}>
            {row.depth > 0 && <span className="workbench-tree-guides" aria-hidden="true" style={{ width: row.depth * 16 }} />}
            {row.kind === "directory" ? <ChevronRight className={row.expanded ? "is-expanded" : ""} size={16} strokeWidth={1.75} aria-hidden="true" />
              : <WorkbenchFileSymbol path={row.path} />}
            <span className="workbench-tree-name">{row.name}</span>
            {row.change ? <span className={`workbench-change-marker is-${row.change}`} aria-label={t(`workbench.${row.change}`)}>{letters[row.change]}</span>
              : row.descendantChanged ? <i className="workbench-directory-changed" aria-label={t("workbench.fileChanges")} /> : null}
          </div>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
