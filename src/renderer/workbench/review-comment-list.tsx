import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, MessageSquare, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { WorkbenchButton } from "./controls";
import { commentLineRange, commentOutdated, formatReviewComments, readReviewComments, reviewCommentScope, writeReviewComments,
  type ReviewComment, type ReviewCommentContext, type ReviewCommentScope } from "./review-comments";
import type { WorkbenchDiffFile } from "./types";

/** Comments live in the workbench store, scoped by project and conversation. */
export function useReviewComments(scope: ReviewCommentScope | undefined, context: ReviewCommentContext | undefined) {
  const scopeKey = scope ? reviewCommentScope(scope) : "";
  // Comments are loaded for one scope at a time; render-phase reset avoids writing
  // another scope's comments into the scope that is being displayed.
  const [state, setState] = useState<{ key: string; comments: ReviewComment[] }>(() => ({ key: scopeKey, comments: scope ? readReviewComments(scope) : [] }));
  if (state.key !== scopeKey) setState({ key: scopeKey, comments: scope ? readReviewComments(scope) : [] });
  useEffect(() => {
    if (scope && state.key === scopeKey) writeReviewComments(scope, state.comments);
  }, [state, scopeKey, scope?.projectRoot, scope?.sessionKey]);
  const update = useCallback((change: (current: ReviewComment[]) => ReviewComment[]) => {
    setState((current) => current.key === scopeKey ? { key: current.key, comments: change(current.comments) } : current);
  }, [scopeKey]);
  const add = useCallback((comment: ReviewComment) => update((current) => [comment, ...current.filter((item) => item.id !== comment.id)]), [update]);
  const resolve = useCallback((id: string) => update((current) => current.map((comment) => comment.id === id
    ? { ...comment, resolvedAt: comment.resolvedAt ? undefined : Date.now() } : comment)), [update]);
  const remove = useCallback((id: string) => update((current) => current.filter((comment) => comment.id !== id)), [update]);
  const versionOf = useCallback((file: WorkbenchDiffFile) => String(file.version), []);
  return { comments: state.key === scopeKey ? state.comments : [], add, resolve, remove, versionOf };
}

export function ReviewComments({ comments, files, context, selected, onToggle, onReveal, onResolve, onDelete, onUsePrompt }: {
  comments: readonly ReviewComment[];
  files: readonly WorkbenchDiffFile[];
  context?: ReviewCommentContext;
  selected: ReadonlySet<string>;
  onToggle(id: string): void;
  onReveal(comment: ReviewComment): void;
  onResolve(id: string): void;
  onDelete(id: string): void;
  onUsePrompt?(text: string): void;
}) {
  const { t } = useI18n();
  const [showResolved, setShowResolved] = useState(false);
  const versions = useMemo(() => new Map(files.map((file) => [file.path, String(file.version)])), [files]);
  const outdated = useCallback((comment: ReviewComment) => commentOutdated(comment, context, versions.get(comment.path)),
    [context?.rangeKey, context?.snapshotId, versions]);
  const visible = comments.filter((comment) => showResolved || !comment.resolvedAt);
  const chosen = visible.filter((comment) => selected.has(comment.id));
  return <section className="review-comments" data-review-comments={comments.length}>
    <header>
      <MessageSquare size={14} />
      <span>{t("reviewComments.title")}</span>
      <span className="workbench-toolbar-spacer" />
      <button type="button" aria-pressed={showResolved} onClick={() => setShowResolved(!showResolved)}>{t("reviewComments.showResolved")}</button>
    </header>
    {visible.length === 0 ? <p className="review-comments-empty" role="status">{t("reviewComments.empty")}</p>
      : <ul>{visible.map((comment) => <li key={comment.id} data-review-comment-row={comment.id} data-comment-outdated={outdated(comment)} data-comment-resolved={Boolean(comment.resolvedAt)}>
        <label className="review-comment-select">
          <input type="checkbox" checked={selected.has(comment.id)} aria-label={t("reviewComments.select")} onChange={() => onToggle(comment.id)} />
          <span className="review-comment-row-path" title={comment.path}>{comment.path}</span>
        </label>
        <button type="button" className="review-comment-row-range" onClick={() => onReveal(comment)}>
          {t(comment.side === "additions" ? "reviewComments.newSide" : "reviewComments.oldSide")} {commentLineRange(comment)}
        </button>
        <div className="review-comment-row-actions">
          {outdated(comment) && <span role="status">{t("reviewComments.outdated")}</span>}
          {comment.resolvedAt && <span>{t("reviewComments.resolved")}</span>}
          <WorkbenchButton label={t(comment.resolvedAt ? "reviewComments.reopen" : "reviewComments.resolve")} data-review-action="resolve-row"
            onClick={() => onResolve(comment.id)}><Check size={13} /></WorkbenchButton>
          <WorkbenchButton label={t("reviewComments.delete")} data-review-action="delete-row" onClick={() => onDelete(comment.id)}><Trash2 size={13} /></WorkbenchButton>
        </div>
        <p data-comment-text>{comment.text}</p>
      </li>)}</ul>}
    <footer>
      <button type="button" data-review-action="use-comments" disabled={!onUsePrompt || chosen.length === 0}
        onClick={() => onUsePrompt?.(formatReviewComments(chosen, { heading: t("reviewComments.draftHeading"),
          side: (side) => t(side === "additions" ? "reviewComments.newSide" : "reviewComments.oldSide") }))}>{t("reviewComments.useInChat")}</button>
      <span role="status">{t("reviewComments.chosen", { count: chosen.length })}</span>
    </footer>
  </section>;
}
