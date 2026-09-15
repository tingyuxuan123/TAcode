import { useMemo } from "react";
import type { SessionFile } from "../conversation";
import { useI18n } from "../i18n";
import { ProjectFilePanel } from "../workbench/project-file-panel";
import { fileScope } from "../workbench/file-view-state";
import type { WorkbenchTreeEntry } from "../workbench/types";

// Retained for callers of the legacy listing helper during the panel migration.
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

export function FilesPanel({ workspace, scope, active = true, files, onOpen }: {
  workspace?: string; scope?: string; active?: boolean; files: SessionFile[];
  onOpen(path: string, options?: { preview?: boolean; literal?: boolean }): void;
}) {
  const { t } = useI18n();
  const changes = useMemo<WorkbenchTreeEntry[]>(() => files.map((file) => ({ path: file.path, kind: "file", change: "modified" })), [files]);
  return workspace ? <ProjectFilePanel root={workspace} scope={scope ?? fileScope(workspace)} active={active} changes={changes} onOpen={onOpen} />
    : <p className="panel-empty">{t("inspect.workspace")}</p>;
}
