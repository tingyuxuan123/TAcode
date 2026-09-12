import { useEffect, useMemo, useState } from "react";
import { FileCode2, Folder, RefreshCw, Search } from "lucide-react";
import type { SessionFile } from "../conversation";
import { useI18n } from "../i18n";

function relativeName(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/$/, "") || path;
}

export function FilesPanel({ workspace, files, onOpen }: {
  workspace?: string;
  files: SessionFile[];
  onOpen(path: string): void;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState("");
  const [loading, setLoading] = useState(Boolean(workspace));
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => window.harness.workspace.onChanged(() => setRevision((value) => value + 1)), []);

  useEffect(() => {
    if (!workspace) {
      setEntries([]);
      setPrefix("");
      setLoading(false);
      return;
    }
    let gone = false;
    setLoading(true);
    setError(undefined);
    void window.harness.workspace.list(workspace).then((next) => {
      if (gone) return;
      setEntries(next);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (gone) return;
      setEntries([]);
      setLoading(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { gone = true; };
  }, [workspace, revision]);

  const changed = useMemo(() => new Set(files.map((file) => file.path.replace(/\\/g, "/"))), [files]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const current = new Map<string, boolean>();
    for (const raw of entries) {
      const entry = raw.replace(/\\/g, "/");
      if (prefix && !entry.startsWith(prefix)) continue;
      const rest = prefix ? entry.slice(prefix.length) : entry;
      if (!rest) continue;
      const slash = rest.indexOf("/");
      const candidate = slash >= 0 ? `${prefix}${rest.slice(0, slash + 1)}` : entry;
      current.set(candidate, current.get(candidate) === true || slash >= 0 || entry.endsWith("/"));
    }
    return [...current.entries()]
      .map(([entry, directory]) => ({ entry, directory }))
      .filter(({ entry }) => !needle || relativeName(entry).toLowerCase().includes(needle))
      .sort((left, right) => {
        if (left.directory !== right.directory) return left.directory ? -1 : 1;
        return left.entry.localeCompare(right.entry, undefined, { sensitivity: "base" });
      });
  }, [entries, prefix, query]);

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
          onClick={() => setRevision((value) => value + 1)}
          title={t("panel.filesOpen")}
          aria-label={t("panel.filesOpen")}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      </header>
      <div className="files-panel-body">
        {!workspace && <p className="panel-empty">{t("inspect.workspace")}</p>}
        {loading && <p className="panel-empty">{t("panel.filesLoading")}</p>}
        {!loading && error && <p className="panel-empty is-error">{error}</p>}
        {!loading && !error && workspace && visible.length === 0 && <p className="panel-empty">{t("panel.filesEmpty")}</p>}
        {!loading && !error && visible.map(({ entry, directory }) => {
          const name = prefix ? entry.slice(prefix.length).replace(/\/$/, "") : relativeName(entry);
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
      </div>
    </div>
  );
}
