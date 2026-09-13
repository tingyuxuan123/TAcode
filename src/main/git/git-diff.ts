import { createHash } from "node:crypto";
import type { GitDiffHunk } from "../../shared/git";
import { decodeGitText, GitReadError } from "./git-process";

export interface RawGitChange {
  path: string;
  previousPath?: string;
  oldMode: string;
  newMode: string;
  oldOid: string | null;
  newOid: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  conflictStages?: { stage: number; oid: string; mode: string }[];
}

const oidOrNull = (oid: string) => /^0+$/.test(oid) ? null : oid;
export const gitDigest = (...parts: (Buffer | string)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) { hash.update(String(Buffer.byteLength(part))); hash.update(":"); hash.update(part); }
  return hash.digest("hex");
};

/** Parses NUL-framed raw + numstat before the patch. Paths may contain tabs/LFs. */
export function parseGitDiff(buffer: Buffer): RawGitChange[] {
  if (!buffer.length) return [];
  const boundary = buffer.indexOf(Buffer.from([0, 0]));
  const metadata = boundary < 0 ? buffer : buffer.subarray(0, boundary + 1);
  const fields = decodeGitText(metadata).split("\0");
  const changes = new Map<string, RawGitChange>();
  let index = 0;
  while (fields[index]?.startsWith(":")) {
    const header = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(fields[index++]);
    if (!header) throw new GitReadError("invalidOutput", "Invalid Git raw change record");
    const [, oldMode, newMode, oldOid, newOid, status] = header;
    const firstPath = fields[index++];
    const renamed = /^[RC]/.test(status);
    const filePath = renamed ? fields[index++] : firstPath;
    if (!filePath) throw new GitReadError("invalidOutput", "Missing Git change path");
    const previous = changes.get(filePath);
    changes.set(filePath, { path: filePath, previousPath: renamed ? firstPath : undefined, oldMode, newMode,
      oldOid: oidOrNull(oldOid), newOid: oidOrNull(newOid), status: previous?.status === "U" ? "U" : status,
      additions: 0, deletions: 0, binary: false, patch: "" });
  }
  const statOrder: string[] = [];
  const seenStats = new Set<string>();
  while (index < fields.length && fields[index]) {
    const record = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index++]);
    if (!record) throw new GitReadError("invalidOutput", "Invalid Git numstat record");
    let filePath = record[3];
    if (!filePath) { index++; filePath = fields[index++]; }
    const change = changes.get(filePath);
    if (!change) throw new GitReadError("invalidOutput", "Git raw and numstat paths disagree");
    change.binary = record[1] === "-" || record[2] === "-";
    change.additions = change.binary ? 0 : Number(record[1]);
    change.deletions = change.binary ? 0 : Number(record[2]);
    if (!seenStats.has(filePath)) { statOrder.push(filePath); seenStats.add(filePath); }
  }
  const patchBytes = boundary < 0 ? Buffer.alloc(0) : buffer.subarray(boundary + 2);
  // Latin-1 is used only to locate ASCII headers: offsets stay byte-exact even
  // when Git treats a non-UTF-8 file as text. Such a file is shown as binary.
  const starts = [...patchBytes.toString("latin1").matchAll(/^diff --(?:git|cc|combined) /gm)].map((match) => match.index!);
  const patches = starts.map((start, index) => patchBytes.subarray(start, starts[index + 1] ?? patchBytes.length));
  const ordinary = statOrder.filter((filePath) => changes.get(filePath)?.status !== "U");
  const order = patches.length === statOrder.length ? statOrder : ordinary;
  if (patches.length !== order.length && patches.length !== 0) throw new GitReadError("invalidOutput", "Git patch and file list disagree");
  for (let i = 0; i < patches.length; i++) {
    const change = changes.get(order[i])!;
    try { change.patch = decodeGitText(patches[i]); }
    catch { change.binary = true; continue; }
    const objectIds = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: \d+)?$/m.exec(change.patch);
    if (objectIds) { change.oldOid = oidOrNull(objectIds[1]); change.newOid = oidOrNull(objectIds[2]); }
  }
  return [...changes.values()];
}

export function parseGitHunks(patch: string): GitDiffHunk[] {
  const matches = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)\n/gm)];
  return matches.map((match, index) => {
    const body = patch.slice(match.index!, matches[index + 1]?.index ?? patch.length);
    return { id: gitDigest(body), oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), heading: match[5].trim(), patch: body };
  });
}

function linesWithEndings(content: string): string[] { return content.match(/[^\n]*\n|[^\n]+$/g) ?? []; }

/** Rebuild Git's normalized new text from frozen old blobs and its actual patch. */
export function applyGitHunks(oldContent: string, hunks: readonly GitDiffHunk[]): string {
  const old = linesWithEndings(oldContent);
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
    if (start < cursor || start > old.length) throw new GitReadError("invalidOutput", "Git hunk is outside the original file");
    for (; cursor < start; cursor++) output.push(old[cursor]);
    cursor = start;
    const lines = linesWithEndings(hunk.patch).slice(1);
    let removed = 0;
    let added = 0;
    for (let i = 0; i < lines.length; i++) {
      const prefix = lines[i][0];
      if (prefix === "\\") continue;
      if (prefix !== " " && prefix !== "+" && prefix !== "-") throw new GitReadError("invalidOutput", "Invalid Git patch line");
      let value = lines[i].slice(1);
      if (lines[i + 1]?.startsWith("\\ No newline at end of file")) value = value.replace(/\n$/, "");
      if (prefix !== "+") {
        if (old[cursor] !== value) throw new GitReadError("changedDuringRead", "Git patch does not match its original blob");
        cursor++; removed++;
      }
      if (prefix !== "-") { output.push(value); added++; }
    }
    if (removed !== hunk.oldLines || added !== hunk.newLines) throw new GitReadError("invalidOutput", "Git hunk line counts disagree");
  }
  for (; cursor < old.length; cursor++) output.push(old[cursor]);
  return output.join("");
}

export function quoteGitPath(value: string): string {
  if (!/[\s"\\\x00-\x1f\x7f]/.test(value)) return value;
  const escapes: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
  return '"' + value.replace(/["\\\x00-\x1f\x7f]/g, (char) => escapes[char] ?? "\\" + char.charCodeAt(0).toString(8).padStart(3, "0")) + '"';
}

export function untrackedPatch(filePath: string, content: string | null, oid: string, mode: string): string {
  const from = quoteGitPath(`a/${filePath}`);
  const to = quoteGitPath(`b/${filePath}`);
  let patch = `diff --git ${from} ${to}\nnew file mode ${mode}\nindex ${"0".repeat(oid.length)}..${oid}\n`;
  if (content === null) return patch + `Binary files /dev/null and ${to} differ\n`;
  const lines = linesWithEndings(content);
  if (!lines.length) return patch;
  patch += `--- /dev/null\n+++ ${to}\n@@ -0,0 +1,${lines.length} @@\n`;
  patch += lines.map((line) => "+" + line).join("");
  if (!content.endsWith("\n")) patch += "\n\\ No newline at end of file\n";
  return patch;
}
