import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import type { WorkspaceReadResult } from "../shared/types";
import { useI18n } from "./i18n";
import { rememberPosition, restorePosition, type ReadingPosition } from "./reading-position";
import { canHighlightCode } from "./code-budget";

const normalized = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");

export function previewChanged(file: string, workspace: string | undefined, root: string, paths?: string[]): boolean {
  if (workspace && normalized(workspace) !== normalized(root)) return false;
  if (!paths || /\.html?$/i.test(file)) return true;
  const base = normalized(workspace ?? root);
  const name = normalized(file).replace(`${base}/`, "").replace(/^\.\//, "");
  return paths.some((part) => {
    const changed = normalized(part);
    return !changed || name === changed || name.startsWith(`${changed}/`);
  });
}

interface PreviewState { key: string; data?: WorkspaceReadResult; loading: boolean; error?: string; revision: number }

/** 只为活动预览读取；切路径、隐藏或卸载后，迟到响应不得更新当前内容。 */
export function useFilePreview(path: string, workspace?: string, active = true) {
  const key = JSON.stringify([workspace, path]);
  const [state, setState] = useState<PreviewState>({ key, loading: true, revision: 0 });
  const bodyRef = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition | undefined>(undefined);
  const reload = useRef<() => void>(() => {});
  const refresh = useCallback(() => reload.current(), []);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let version = 0;
    const read = () => {
      const request = ++version;
      setState((old) => old.key === key ? { ...old, loading: true, error: undefined } : { key, loading: true, revision: 0 });
      void window.harness.workspace.read(path, workspace).then((data) => {
        if (!alive || version !== request) return;
        if (bodyRef.current) position.current = rememberPosition(bodyRef.current);
        setState((old) => ({ key, data, loading: false, revision: old.revision + 1 }));
      }, (error: unknown) => {
        if (!alive || version !== request) return;
        setState((old) => ({ ...old, loading: false, error: error instanceof Error ? error.message : String(error) }));
      });
    };
    reload.current = read;
    const unsubscribe = window.harness.workspace.onChanged((root, paths) => { if (previewChanged(path, workspace, root, paths)) read(); });
    read();
    return () => { alive = false; reload.current = () => {}; unsubscribe(); };
  }, [path, workspace, active, key]);
  useLayoutEffect(() => {
    if (bodyRef.current && position.current) restorePosition(bodyRef.current, position.current);
    position.current = undefined;
  }, [state.revision]);
  const current = state.key === key ? state : { key, loading: true, revision: 0 };
  return { ...current, refresh, bodyRef };
}

export function FilePreviewStatus({ data, loading, error, refresh }: ReturnType<typeof useFilePreview>) {
  const { t } = useI18n();
  return <>
    {error && <div className="file-preview-notice" role="alert"><span>{t("preview.failed")} {error}</span><button type="button" onClick={refresh}>{t("common.retry")}</button></div>}
    {loading && !data && <p className="file-preview-notice" role="status">{t("preview.reading")}</p>}
    {data?.status === "missing" ? <p className="file-preview-notice" role="status">{t("preview.missing")}</p>
      : data?.binary ? <p className="file-preview-notice" role="status">{t("preview.binary")}</p>
        : data && !data.content ? <p className="file-preview-notice" role="status">{t("preview.empty")}</p> : null}
    {data?.truncated && <p className="file-preview-notice" role="status">{t("preview.truncated")}</p>}
    {data && !data.binary && data.content && (data.truncated || !/\.html?$/i.test(data.path)) && !canHighlightCode(data.content) && <p className="file-preview-notice">{t("preview.plain")}</p>}
  </>;
}

export function FilePreviewActions({ data, loading, refresh }: ReturnType<typeof useFilePreview>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1400); return () => clearTimeout(timer); } }, [copied]);
  return <>
    <button type="button" className="drawer-btn" aria-label={t("preview.refresh")} title={t("preview.refresh")} aria-busy={loading} onClick={refresh}><RefreshCw size={15} /></button>
    <button type="button" className="drawer-btn" disabled={!data || data.binary || data.status === "missing"} aria-label={copied ? t("common.copied") : t("common.copy")} onClick={() => { if (data) void navigator.clipboard.writeText(data.content).then(() => setCopied(true), () => {}); }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
  </>;
}
