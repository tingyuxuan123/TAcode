import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GitBranch, GitReviewQuery, GitTurnSnapshotState } from "../../shared/git";
import { gitReviewQueryKey } from "../../shared/git";
import { useI18n } from "../i18n";
import { createImeGuard } from "../ime";
import { gitSnapshotFiles } from "./git-review-model";
import { GitReviewStore, gitReviewStateKey } from "./git-review-store";
import { ReviewWorkbench } from "./review-workbench";
import type { ReviewScope, WorkbenchColorScheme } from "./types";
import { useWorkbenchVisible } from "./use-workbench-visible";
import { GitMutationDialogs, GitMutationNotice, useGitMutationActions } from "./git-mutation-actions";
import { GitCommitDialogs, GitCommitNotice, useGitCommitActions } from "./git-commit-actions";
import { comparisonRangeKey, comparisonSnapshotId } from "./review-comments";

const branchKey = (root: string) => `tacode:review-base:${root}`;
function readBase(root: string): string {
  try { return localStorage.getItem(branchKey(root)) ?? ""; } catch { return ""; }
}

/** A project-keyed instance never inherits another project's reference or result. */
export function GitReviewPanel(props: {
  projectRoot?: string;
  /** Conversation the comments belong to; project + session keeps them apart. */
  sessionKey?: string;
  active: boolean;
  onOpenFile?(path: string): void;
  onChooseProject?(): void;
  onOpenTerminal?(): void;
  onUsePrompt?(text: string): void;
  colorScheme?: WorkbenchColorScheme;
  onWorkerStateChange?: Parameters<typeof ReviewWorkbench>[0]["onWorkerStateChange"];
}) {
  return <ProjectGitReview key={props.projectRoot ?? "no-project"} {...props} />;
}

function ProjectGitReview({ projectRoot, sessionKey, active, onOpenFile, onChooseProject, onOpenTerminal, onUsePrompt, colorScheme, onWorkerStateChange }: Parameters<typeof GitReviewPanel>[0]) {
  const { t, locale } = useI18n();
  const { ref, visible } = useWorkbenchVisible(active);
  const [scope, setScope] = useState<ReviewScope>("unstaged");
  const [base, setBase] = useState(() => readBase(projectRoot ?? ""));
  const [commit, setCommit] = useState("HEAD");
  const [commitInput, setCommitInput] = useState("HEAD");
  const [turn, setTurn] = useState<GitTurnSnapshotState>();
  const [turnVersion, setTurnVersion] = useState(0);
  const ime = useRef(createImeGuard());
  const turnScope = scope === "lastTurn";
  const turnReady = turn?.kind === "turn";
  useEffect(() => {
    if (!projectRoot || !visible || !turnScope) return;
    let disposed = false;
    const load = () => void window.harness.git.turnSnapshot({ projectRoot }).then((next) => { if (!disposed) setTurn(next); },
      () => { if (!disposed) setTurn({ kind: "error", error: { code: "failed", message: t("workbench.gitError.noTurnSnapshot") } }); });
    load();
    const off = window.harness.git.onTurnSnapshot((update) => { if (update.projectRoot === projectRoot) load(); });
    return () => { disposed = true; off(); };
  }, [projectRoot, visible, turnScope, turnVersion]);
  const query = useMemo<GitReviewQuery>(() => scope === "commit" ? { kind: "commit", commit }
    : scope === "branch" ? base ? { kind: "branch", base } : { kind: "repository" }
      : scope === "lastTurn" ? turn?.kind === "turn" ? { kind: "turn", snapshotId: turn.snapshot.id } : { kind: "repository" }
        : scope === "staged" ? { kind: "staged" } : { kind: "unstaged" }, [scope, base, commit, turn]);
  const queryKey = gitReviewQueryKey(query);
  const store = useMemo(() => new GitReviewStore(window.harness.git), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const actions = useGitMutationActions(store, projectRoot, queryKey);
  const commitActions = useGitCommitActions(store, projectRoot, queryKey);
  useEffect(() => {
    if (!projectRoot || !visible) return;
    if (turnScope && !turnReady) return;
    return store.connect(projectRoot, query);
  }, [store, projectRoot, queryKey, visible, turnScope, turnReady]);
  const current = state.key === gitReviewStateKey(projectRoot ?? "", query);
  const result = current ? state.result : undefined;
  const turnBlocked = turnScope && turn !== undefined && turn.kind !== "turn";
  const busy = Boolean(projectRoot && visible && !turnBlocked && (!current || state.loading)) || actions.busy || commitActions.busy;
  const snapshot = result?.kind === "ready" ? result.snapshot : undefined;
  const branchCache = useRef<readonly GitBranch[]>([]);
  if (result?.kind === "ready" || result?.kind === "repository") branchCache.current = result.branches;
  else if (result?.kind === "notRepository" || result?.kind === "missingGit") branchCache.current = [];
  const branches = branchCache.current;
  const files = useMemo(() => snapshot ? gitSnapshotFiles(snapshot) : [], [snapshot]);
  const setBranch = (value: string) => {
    setBase(value);
    try { if (projectRoot) localStorage.setItem(branchKey(projectRoot), value); } catch { /* Memory-only selection remains usable. */ }
  };

  let emptyState;
  if (!projectRoot) emptyState = <><p>{t("workbench.chooseProject")}</p>{onChooseProject && <button type="button" onClick={onChooseProject}>{t("workbench.openProject")}</button>}</>;
  else if (turnScope && turn && turn.kind !== "turn") emptyState = <div className="workbench-turn-notice" data-turn-notice={turn.kind}
    role={turn.kind === "capturing" || turn.kind === "missing" ? "status" : "alert"}>
    <p>{turn.kind === "capturing" ? t("workbench.lastTurnRecording")
      : turn.kind === "missing" ? t("workbench.lastTurnMissing")
        : turn.kind === "expired" ? t("workbench.lastTurnExpired")
          : turn.kind === "failed" ? t("workbench.lastTurnFailed", { reason: turn.reason })
            : t("workbench.gitError.noTurnSnapshot")}</p>
    {turn.kind === "error" && <details><summary>{t("workbench.errorDetails")}</summary><pre>{turn.error.details || turn.error.message}</pre></details>}
    {turn.kind !== "capturing" && <button type="button" onClick={() => setTurnVersion((value) => value + 1)}>{t("common.retry")}</button>}
  </div>;
  else if (busy && !result) emptyState = t("workbench.loading");
  else if (result?.kind === "missingGit") emptyState = <><p>{t("workbench.missingGit")}</p><button type="button" onClick={() => void window.harness.app.openExternal("https://git-scm.com/downloads")}>{t("workbench.installGit")}</button><button type="button" onClick={store.refresh}>{t("workbench.refresh")}</button></>;
  else if (result?.kind === "notRepository") emptyState = <><p>{t("workbench.notRepository")}</p>{onOpenTerminal && <button type="button" onClick={onOpenTerminal}>{t("workbench.openTerminal")}</button>}<button type="button" onClick={store.refresh}>{t("workbench.refresh")}</button></>;
  else if (result?.kind === "error") emptyState = <div className="workbench-review-error" role="alert">
    <p>{t(`workbench.gitError.${result.error.code}`)}</p>
    <details><summary>{t("workbench.errorDetails")}</summary><pre>{result.error.details || result.error.message}</pre></details>
    <button type="button" onClick={store.refresh}>{t("common.retry")}</button>
  </div>;
  else if (scope === "branch" && !base) emptyState = t(branches.length ? "workbench.chooseBaseHint" : "workbench.noBranches");

  const history = scope === "commit" || scope === "branch";
  const turnSummary = turn?.kind === "turn" ? <div className="workbench-turn-summary" data-turn-snapshot={turn.snapshot.id}>
    <span>{t("workbench.lastTurnSummary", { files: turn.snapshot.files, time: new Date(turn.snapshot.settledAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" }) })}</span>
    {turn.snapshot.status === "stopped" && <span role="status">{t("workbench.lastTurnStopped")}</span>}
    {turn.snapshot.unfinished.length > 0 && <details className="workbench-turn-note" open>
      <summary>{t("workbench.lastTurnUnfinished")}</summary>
      <ul>{turn.snapshot.unfinished.map((command, index) => <li key={`${command.tool}-${index}`}><code>{command.command}</code>
        {command.processId && <span>{` · ${command.processId}`}</span>}</li>)}</ul>
    </details>}
    {turn.snapshot.warnings.length > 0 && <details className="workbench-turn-note">
      <summary>{t("workbench.lastTurnWarnings")}</summary>
      <ul>{turn.snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </details>}
  </div> : undefined;
  const scopeDetails = turnScope || history || state.watchMode === "polling" ? <div className="workbench-scope-details">
    {turnSummary}
    {scope === "commit" && <form onSubmit={(event) => { event.preventDefault(); if (!ime.current.active() && !ime.current.recent() && commitInput.trim()) setCommit(commitInput.trim()); }}>
      <label htmlFor="review-commit-ref">{t("workbench.commitReference")}</label>
      <input id="review-commit-ref" value={commitInput} spellCheck={false} maxLength={1024} onChange={(event) => setCommitInput(event.target.value)}
        onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
        onKeyDown={(event) => { if (event.key === "Enter" && ime.current.handles(event.nativeEvent)) event.preventDefault(); }} />
      <button type="submit" disabled={!commitInput.trim()}>{t("workbench.compare")}</button>
    </form>}
    {scope === "branch" && <label>{t("workbench.baseBranch")}
      <select aria-label={t("workbench.baseBranch")} value={base} onChange={(event) => setBranch(event.target.value)}>
        <option value="">{t("workbench.chooseBase")}</option>
        {base && !branches.some((branch) => branch.ref === base) && <option value={base}>{base}</option>}
        {branches.map((branch) => <option key={branch.ref} value={branch.ref}>{branch.name}{branch.current ? ` (${t("workbench.currentBranch")})` : ""}</option>)}
      </select>
    </label>}
    {snapshot && history && <span className="workbench-reference-summary" title={`${snapshot.baseCommit ?? t("workbench.emptyTree")} → ${snapshot.targetCommit ?? ""}`}>
      {snapshot.baseCommit?.slice(0, 8) ?? t("workbench.emptyTree")} → {snapshot.targetCommit?.slice(0, 8)}
      {scope === "branch" && <span> · {t("workbench.fromMergeBase")}</span>}
    </span>}
    {state.watchMode === "polling" && <span role="status">{t("workbench.polling")}</span>}
  </div> : undefined;

  return <div ref={ref} className="git-review-panel" data-review-state={busy ? "loading" : result?.kind ?? "idle"}
    data-review-project={projectRoot} data-snapshot-id={snapshot?.id} data-review-active={visible} aria-busy={busy}
    data-turn-state={turn?.kind ?? "loading"} data-turn-scope={turnScope}>
    <ReviewWorkbench files={files} scope={scope} onScopeChange={setScope} onOpenFile={onOpenFile}
      onRefresh={projectRoot ? () => { if (turnScope) { setTurnVersion((value) => value + 1); store.refresh(); } else store.refresh(); } : undefined} busy={busy} paused={!visible} comparisonKey={queryKey}
      onMutation={snapshot && !snapshot.readOnly ? actions.onMutation : undefined}
      onStageAll={snapshot && scope === "unstaged" ? () => actions.onMutation("stage", { kind: "all" }) : undefined}
      onUnstageAll={snapshot && scope === "staged" ? () => actions.onMutation("unstage", { kind: "all" }) : undefined}
      onDiscardAll={snapshot && !snapshot.readOnly ? () => actions.onMutation("discard", { kind: "all" }) : undefined}
      onRecoveries={projectRoot ? actions.showRecoveries : undefined}
      onCommit={snapshot && !snapshot.readOnly ? commitActions.openDialog : undefined}
      onWorkerStateChange={onWorkerStateChange}
      colorScheme={colorScheme}
      dialogs={<><GitMutationDialogs actions={actions} /><GitCommitDialogs actions={commitActions} /></>}
      scopeDetails={scopeDetails || actions.phase || actions.result || commitActions.result ? <><>{scopeDetails}</><GitMutationNotice actions={actions} onRefresh={store.refresh} /><GitCommitNotice actions={commitActions} /></> : undefined}
      commentScope={projectRoot && sessionKey ? { projectRoot, sessionKey } : undefined}
      commentContext={{ rangeKey: comparisonRangeKey(query), snapshotId: comparisonSnapshotId(query) }}
      reviewScope={projectRoot && query.kind !== "repository" ? { projectRoot, comparison: query, snapshotId: comparisonSnapshotId(query) } : undefined}
      onUsePrompt={onUsePrompt}
      emptyState={emptyState} />
  </div>;
}
