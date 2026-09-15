import { useCallback, useEffect, useState } from "react";
import { Ban, Bot, RefreshCw, ShieldAlert } from "lucide-react";
import type { GitComparison } from "../../shared/git";
import { gitReviewQueryKey } from "../../shared/git";
import type { ReviewRun, ReviewSeverity } from "../../shared/review";
import { useI18n } from "../i18n";
import { WorkbenchButton } from "./controls";

export interface ReviewScopeRef { projectRoot: string; comparison: GitComparison; snapshotId: string }

/** Runs live in the main process; history is read back so a reload keeps everything visible. */
export function useReviewRuns(scope: ReviewScopeRef | undefined, active: boolean) {
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [error, setError] = useState<string>();
  const projectRoot = scope?.projectRoot;
  useEffect(() => {
    if (!projectRoot || !active) return;
    let disposed = false;
    const load = () => void window.harness.review.list(projectRoot).then((next) => { if (!disposed) { setRuns(next); setError(undefined); } },
      (reason: unknown) => { if (!disposed) setError(String(reason)); });
    load();
    const off = window.harness.review.onUpdate((update) => {
      if (update.projectRoot !== projectRoot) return;
      setRuns((current) => [update, ...current.filter((run) => run.id !== update.id)].slice(0, 20));
    });
    return () => { disposed = true; off(); };
  }, [projectRoot, active]);
  const start = useCallback(async (requirements: string) => {
    if (!scope) return;
    setError(undefined);
    try { const run = await window.harness.review.start({ projectRoot: scope.projectRoot, comparison: scope.comparison,
      ...(scope.snapshotId ? { snapshotId: scope.snapshotId } : {}), ...(requirements.trim() ? { requirements: requirements.trim() } : {}) });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    } catch (reason) { setError(String(reason)); }
  }, [scope?.projectRoot, JSON.stringify(scope?.comparison ?? null), scope?.snapshotId]);
  const cancel = useCallback((id: string) => { void window.harness.review.cancel(id); }, []);
  const retry = useCallback(async (id: string) => {
    setError(undefined);
    try { const run = await window.harness.review.retry(id); if (run) setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]); }
    catch (reason) { setError(String(reason)); }
  }, []);
  return { runs, error, start, cancel, retry };
}

/** A run is stale when the range or snapshot it reviewed is no longer the one on screen. */
export function reviewRunStale(run: ReviewRun, scope: ReviewScopeRef | undefined): boolean {
  if (!scope) return true;
  return run.snapshotId !== scope.snapshotId || gitReviewQueryKey(run.comparison) !== gitReviewQueryKey(scope.comparison);
}

export function ReviewFindings({ scope, active, expanded = false, onReveal }: {
  scope?: ReviewScopeRef;
  active: boolean;
  /** The list stays collapsed by default so the review column keeps room for the file tree. */
  expanded?: boolean;
  onReveal(path: string, line: number, side: "old" | "new"): void;
}) {
  const { t } = useI18n();
  const { runs, error, start, cancel, retry } = useReviewRuns(scope, active);
  const [requirements, setRequirements] = useState("");
  const [selected, setSelected] = useState<string>();
  const current = runs.find((run) => run.id === selected) ?? runs[0];
  const stale = current ? reviewRunStale(current, scope) : false;
  const running = current?.status === "running";
  const status = (run: ReviewRun): string => t(run.status === "running" ? "review.running" : run.status === "completed" ? "review.completed"
    : run.status === "cancelled" ? "review.cancelled" : "review.failed");
  return <section className="review-findings" data-review-findings={runs.length} data-current-run={current?.id ?? ""}
    data-run-status={current?.status ?? "none"} data-run-stale={stale}>
    <header>
      <Bot size={14} />
      <span>{t("review.title")}</span>
      <span className="workbench-toolbar-spacer" />
      {running
        ? <WorkbenchButton label={t("review.cancel")} data-review-run-action="cancel" onClick={() => current && cancel(current.id)}><Ban size={13} /></WorkbenchButton>
        : <WorkbenchButton label={current ? t("review.restart") : t("review.start")} data-review-run-action="start"
          onClick={() => void start(requirements)}><RefreshCw size={13} /></WorkbenchButton>}
    </header>
    {expanded && runs.length > 1 && <select aria-label={t("review.history")} value={current?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>
      {runs.map((run) => <option key={run.id} value={run.id}>{`${status(run)} · ${new Date(run.startedAt).toLocaleTimeString()} · ${run.findings.length}`}</option>)}
    </select>}
    <textarea aria-label={t("review.requirements")} placeholder={t("review.requirementsPlaceholder")} rows={2} value={requirements}
      disabled={running} onChange={(event) => setRequirements(event.target.value)} />
    {error && <p role="alert">{error}</p>}
    {!current && active && <p className="review-comments-empty" role="status">{t("review.empty")}</p>}
    {current && <>
      <p className="review-run-status" role="status">
        <span>{status(current)}</span>
        <span>{t("review.coverage", { files: current.coverage.files })}</span>
        {current.coverage.truncated && <span role="status">{t("review.truncated")}</span>}
        {stale && <span data-review-stale="true" role="status">{t("review.stale")}</span>}
      </p>
      {current.error && <p role="alert">{current.error}</p>}
      <div className="review-findings-body">
        {expanded && current.coverage.notes.length > 0 && <details className="workbench-turn-note" open>
          <summary>{t("review.notes")}</summary>
          <ul>{current.coverage.notes.map((note) => <li key={note}>{note}</li>)}</ul>
        </details>}
        {expanded && current.status === "completed" && current.findings.length === 0 && <p role="status">{t("review.none")}</p>}
        {expanded && current.findings.length > 0 && <ul className="review-finding-list">{current.findings.map((finding) => <li key={finding.id}
          data-review-finding={finding.id} data-severity={finding.severity} data-finding-path={finding.path} data-finding-side={finding.side} data-finding-line={finding.line}>
          <div className="review-finding-head">
            <span className={`review-severity is-${finding.severity}`} data-severity={finding.severity}>{t(`review.severity.${finding.severity}`)}</span>
            <button type="button" className="review-finding-location" onClick={() => onReveal(finding.path, finding.line, finding.side)}>
              {`${finding.path}:${finding.line}`}<span> · {t(finding.side === "new" ? "review.side.new" : "review.side.old")}</span>
            </button>
            <span className="review-finding-confidence">{t(`review.confidence.${finding.confidence}`)}</span>
          </div>
          <p data-finding-title>{finding.title}</p>
          <details><summary>{t("review.evidence")}</summary><pre data-finding-evidence>{finding.evidence}</pre></details>
        </li>)}</ul>}
        {expanded && current.rejected.length > 0 && <details className="review-rejected" open data-review-rejected={current.rejected.length}>
          <summary>{t("review.rejected", { count: current.rejected.length })}</summary>
          <ul>{current.rejected.map((item, index) => <li key={`${item.reason}-${index}`}><ShieldAlert size={12} /><span>{item.reason}</span>
            <pre>{item.raw}</pre></li>)}</ul>
        </details>}
        {current.status !== "running" && <div className="review-run-actions">
          <button type="button" data-review-run-action="retry" onClick={() => void retry(current.id)}>{t("review.retry")}</button>
        </div>}
      </div>
    </>}
  </section>;
}

export const severityLabel = (severity: ReviewSeverity): string => `review.severity.${severity}`;
