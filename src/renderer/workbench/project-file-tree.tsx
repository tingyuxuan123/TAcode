import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceFiles } from "../workspace-files";
import { useI18n } from "../i18n";
import type { FileEntry, FileFailure } from "../../shared/files";
import type { FileViewState } from "./file-view-state";
import type { WorkbenchTreeEntry } from "./types";
import { WorkbenchFileTree } from "./file-tree";

export function ProjectFileTree({ root, path, active, view, onViewChange, onOpen, reveal, changes = [] }: {
  root: string; path?: string; active: boolean; view: FileViewState; onViewChange(change: Partial<FileViewState>): void;
  onOpen(path: string, options?: { preview?: boolean; literal?: boolean }): void; reveal?: number; changes?: readonly WorkbenchTreeEntry[];
}) {
  const { t } = useI18n();
  const index = useWorkspaceFiles(active ? root : undefined);
  const lastIndex = useRef(index.entries); if (active && index.entries.length) lastIndex.current = index.entries;
  const [directories, setDirectories] = useState<Map<string, readonly FileEntry[]>>(new Map());
  const [error, setError] = useState<FileFailure>();
  const [query, setQuery] = useState(view.query ?? "");
  const loaded = useRef(new Set<string>()); const jobs = useRef(new Map<string, Promise<void>>());
  const refreshPending = useRef(new Set<string>());
  const generation = useRef(0); const enabled = useRef(active); enabled.current = active;
  const load = useCallback((directory: string, refresh = false): Promise<void> => {
    if (!enabled.current || (!refresh && loaded.current.has(directory))) return Promise.resolve();
    const prior = jobs.current.get(directory); if (prior) { if (refresh) refreshPending.current.add(directory); return prior; }
    const current = generation.current;
    const job = (async () => {
      try {
        let cursor: string | undefined; const entries: FileEntry[] = [];
        do {
          const page = await window.harness.files.directory({ projectRoot: root, path: directory, cursor, includeIgnored: true, refresh: refresh && !cursor });
          if (current !== generation.current || !enabled.current) return;
          if (page.kind === "error") { setError(page.error); return; }
          entries.push(...page.entries); cursor = page.cursor;
        } while (cursor);
        loaded.current.add(directory); setError(undefined);
        setDirectories((old) => new Map(old).set(directory, entries));
      } catch (error) { if (current === generation.current && enabled.current) setError({ code: "failed", message: String(error) }); }
    })().finally(() => {
      if (jobs.current.get(directory) !== job) return;
      jobs.current.delete(directory);
      if (refreshPending.current.delete(directory)) void load(directory, true);
    });
    jobs.current.set(directory, job); return job;
  }, [root]);
  useEffect(() => {
    if (!active) return;
    void load("", true); for (const directory of view.expanded ?? []) void load(directory, true);
    const subscriptionId = crypto.randomUUID(); let sequence = 0; const current = generation.current;
    const off = window.harness.files.onUpdate((update) => {
      if (update.subscriptionId !== subscriptionId || update.projectRoot !== root || update.path !== "" || update.sequence <= sequence) return;
      sequence = update.sequence;
      if (update.kind === "error") { setError(update.error); return; }
      for (const directory of loaded.current) if (!update.paths || update.paths.some((value) => !value || !directory || value === directory || value.startsWith(`${directory}/`) || directory.startsWith(`${value}/`))) void load(directory, true);
    });
    void window.harness.files.subscribe({ projectRoot: root, path: "", target: "directory", subscriptionId }).then((result) => {
      if (current !== generation.current) { void window.harness.files.unsubscribe(subscriptionId).catch(() => {}); return; }
      if ("kind" in result) setError(result.error);
    }).catch((error) => { if (current === generation.current) setError({ code: "failed", message: String(error) }); });
    return () => { generation.current++; jobs.current.clear(); refreshPending.current.clear(); off(); void window.harness.files.unsubscribe(subscriptionId).catch(() => {}); };
  }, [active, root, load]);
  const entries = useMemo(() => {
    const all = new Map<string, WorkbenchTreeEntry>();
    for (const value of active ? index.entries : lastIndex.current) all.set(value.replace(/\/$/, ""), { path: value.replace(/\/$/, ""), kind: value.endsWith("/") ? "directory" : "file" });
    for (const list of directories.values()) for (const entry of list) all.set(entry.path, { path: entry.path, kind: entry.kind === "directory" ? "directory" : "file" });
    for (const entry of changes) if (all.has(entry.path)) all.set(entry.path, { ...all.get(entry.path)!, change: entry.change });
    return [...all.values()];
  }, [active, index.entries, directories, changes]);
  const expand = useCallback((directory: string) => {
    // The complete normal index already contains these subtrees; explicit directories reveal ignored entries too.
    void load(directory);
  }, [load]);
  const expanded = useCallback((paths: string[]) => onViewChange({ expanded: paths }), [onViewChange]);
  const previousReveal = useRef(reveal);
  useEffect(() => { if (previousReveal.current !== reveal) { previousReveal.current = reveal; setQuery(""); onViewChange({ query: "" }); } }, [reveal, onViewChange]);
  return <div className="project-file-tree">
    {(error || index.error) && <div className="file-tree-notice" role="alert"><span>{t("fileView.treeFailed")}</span><button type="button" onClick={() => { void index.refresh(); for (const directory of loaded.current) void load(directory, true); void load("", true); }}>{t("common.retry")}</button></div>}
    {index.loading && !entries.length && <p className="workbench-empty" role="status">{t("workbench.loading")}</p>}
    <WorkbenchFileTree entries={entries} selectedPath={path} query={query} onQueryChange={(value) => { setQuery(value); onViewChange({ query: value }); }}
      onOpen={(value) => onOpen(value, { preview: true, literal: true })} onDoubleOpen={(value) => onOpen(value, { preview: false, literal: true })}
      onExpand={expand} initialExpanded={view.expanded} initialScroll={view.treeScroll} restoreReady={!index.loading && loaded.current.has("") && (view.expanded ?? []).every((directory) => loaded.current.has(directory))}
      onScrollChange={(top) => onViewChange({ treeScroll: top })} onExpandedChange={expanded} reveal={reveal} />
  </div>;
}
