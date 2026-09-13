import type { WorkbenchTreeEntry } from "./types";

export interface WorkbenchTreeRow extends WorkbenchTreeEntry {
  name: string;
  parent: string;
  depth: number;
  expanded: boolean;
  descendantChanged: boolean;
}

export function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Fill directory ancestors without hiding dotfiles or ignored directories. */
export function completeTreeEntries(entries: readonly WorkbenchTreeEntry[]): WorkbenchTreeEntry[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    for (const parent of ancestorPaths(entry.path)) {
      if (!byPath.has(parent)) byPath.set(parent, { path: parent, kind: "directory" });
    }
  }
  return [...byPath.values()];
}

/** Filtering matches full paths before reducing to the visible tree. */
export function visibleTreeRows(entries: readonly WorkbenchTreeEntry[], expanded: ReadonlySet<string>, query = ""): WorkbenchTreeRow[] {
  const complete = completeTreeEntries(entries);
  const needle = query.trim().toLocaleLowerCase();
  const included = new Set<string>();
  const changedAncestors = new Set<string>();
  for (const entry of complete) {
    if (entry.change) for (const parent of ancestorPaths(entry.path)) changedAncestors.add(parent);
    if (!needle || entry.path.toLocaleLowerCase().includes(needle)) {
      included.add(entry.path);
      for (const parent of ancestorPaths(entry.path)) included.add(parent);
    }
  }
  const children = new Map<string, WorkbenchTreeEntry[]>();
  for (const entry of complete) {
    if (!included.has(entry.path)) continue;
    const slash = entry.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : entry.path.slice(0, slash);
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const rows: WorkbenchTreeRow[] = [];
  const visit = (parent: string, depth: number) => {
    const siblings = children.get(parent) ?? [];
    siblings.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory")
      || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path));
    for (const entry of siblings) {
      const open = entry.kind === "directory" && (Boolean(needle) || expanded.has(entry.path));
      rows.push({ ...entry, name: entry.path.slice(parent ? parent.length + 1 : 0), parent, depth, expanded: open, descendantChanged: changedAncestors.has(entry.path) });
      if (open) visit(entry.path, depth + 1);
    }
  };
  visit("", 0);
  return rows;
}
