import { useEffect, useMemo, useState } from "react";
import { FileCode2, Folder, RefreshCw, Search } from "lucide-react";
import type { SessionFile } from "../conversation";
import { useI18n } from "../i18n";
import { useWorkspaceFiles } from "../workspace-files";

function relativeName(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/$/, "") || path;
}

export function visibleWorkspaceFiles(entries: string[], prefix: string, query: string): Array<{ entry: string; directory: boolean }> {
  const needle = query.trim().toLowerCase();
  const current = new Map<string, boolean>();
  for (const raw of entries) {
    const entry = raw.replace(/\\/g, "/");
    if (needle) {
      if (entry.toLowerCase().includes(needle)) current.set(entry, entry.endsWith("/"));
      continue;
    }
    if (prefix && !entry.startsWith(prefix)) continue;
    const rest = prefix ? entry.slice(prefix.length) : entry;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    const candidate = slash >= 0 ? `${prefix}${rest.slice(0, slash + 1)}` : entry;
    current.set(candidate, current.get(candidate) === true || slash >= 0 || entry.endsWith("/"));
  }
  return [...current].map(([entry, directory]) => ({ entry, directory })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.entry.localeCompare(b.entry, undefined, { sensitivity: "base" }));
}

export function FilesPanel({ workspace, files, onOpen }: {
  workspace?: string;
  files: SessionFile[];
  onOpen(path: string): void;
}) {
  const { t } = useI18n();
  const { entries, loading, error, refresh } = useWorkspaceFiles(workspace);
  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState("");
  const [shown, setShown] = useState(200);
  useEffect(() => { setPrefix(""); setQuery(""); }, [workspace]);
  useEffect(() => setShown(200), [workspace, prefix, query]);

  const changed = useMemo(() => new Set(files.map((file) => file.path.replace(/\\/g, "/"))), [files]);
  const visible = useMemo(() => visibleWorkspaceFiles(entries, prefix, query), [entries, prefix, query]);

  return (
    <div className="files-panel">
      <header className="files-panel-toolbar">
        <button type="button" className="files-breadcrumb" disabled={!prefix} onClick={() => setPrefix(prefix.replace(/[^/]+\/$/, ""))} title={prefix || workspace}>{prefix ? `/${prefix}` : "/"}</button>
        <label className="files-search">
          <Search size={14} strokeWidth={1.8} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("panel.filesSearch")}
            aria-label={t("panel.filesSearch")}
          />
        </label>
        <button
          type="button"
          className="panel-icon-button"
          onClick={() => void refresh()}
          title={t("panel.filesRefresh")}
          aria-label={t("panel.filesRefresh")}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      </header>
      <div className="files-panel-body">
        {!workspace && <p className="panel-empty">{t("inspect.workspace")}</p>}
        {loading && entries.length === 0 && <p className="panel-empty">{t("panel.filesLoading")}</p>}
        {!loading && error && <p className="panel-empty is-error" role="alert">{error}<button type="button" className="ghost" onClick={() => void refresh()}>{t("common.retry")}</button></p>}
        {!loading && !error && workspace && visible.length === 0 && <p className="panel-empty">{t("panel.filesEmpty")}</p>}
        {!error && visible.slice(0, shown).map(({ entry, directory }) => {
          const name = prefix && !query.trim() ? entry.slice(prefix.length).replace(/\/$/, "") : relativeName(entry);
          const dirty = !directory && changed.has(entry.replace(/\\/g, "/"));
          return (
            <button
              key={entry}
              type="button"
              className={`files-entry${dirty ? " is-dirty" : ""}`}
              onClick={() => {
                if (directory) {
                  setPrefix(entry);
                  setQuery("");
                } else {
                  onOpen(entry);
                }
              }}
              title={entry}
            >
              {directory ? <Folder size={15} strokeWidth={1.7} aria-hidden="true" /> : <FileCode2 size={15} strokeWidth={1.7} aria-hidden="true" />}
              <span>{name}</span>
              {dirty && <i className="files-dirty-dot" aria-label={t("inspect.changed")} />}
            </button>
          );
        })}
        {!error && shown < visible.length && <button type="button" className="ghost files-load-more" onClick={() => setShown((value) => value + 200)}>{t("panel.filesMore", { count: visible.length - shown })}</button>}
      </div>
    </div>
  );
}
