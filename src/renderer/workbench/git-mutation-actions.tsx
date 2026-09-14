import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitMutationAction, GitMutationPreview, GitMutationResult, GitMutationTarget, GitRecoveryPoint } from "../../shared/git";
import { useI18n } from "../i18n";
import type { GitReviewStore } from "./git-review-store";

type Phase = "preparing" | "applying" | undefined;
const failed = (error: unknown): GitMutationResult => ({ kind: "error", error: { code: "failed", message: error instanceof Error ? error.message : String(error) } });

export function useGitMutationActions(store: GitReviewStore, projectRoot: string | undefined, comparisonKey: string) {
  const epoch = useRef(0);
  const running = useRef(false);
  const pending = useRef<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>();
  const [confirmation, setConfirmation] = useState<GitMutationPreview>();
  const [result, setResult] = useState<GitMutationResult>();
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveries, setRecoveries] = useState<GitRecoveryPoint[]>();
  const [selectedRecovery, setSelectedRecovery] = useState<GitRecoveryPoint>();
  useEffect(() => {
    setPhase(undefined); running.current = false; setConfirmation(undefined); setResult(undefined);
    return () => {
      epoch.current++;
      if (pending.current) void window.harness.git.cancelMutation(pending.current).catch(() => undefined);
      pending.current = undefined;
    };
  }, [comparisonKey, projectRoot]);

  const apply = useCallback(async (preview: GitMutationPreview, generation: number) => {
    setConfirmation(undefined); pending.current = undefined; setPhase("applying");
    const value = await window.harness.git.applyMutation(preview.token).catch(failed);
    if (generation !== epoch.current) return;
    setResult(value); setPhase(undefined); running.current = false; store.refresh();
  }, [store]);
  const onMutation = useCallback((action: GitMutationAction, target: GitMutationTarget) => {
    if (running.current) return;
    running.current = true; setPhase("preparing"); setResult(undefined);
    const generation = epoch.current;
    void (async () => {
      const value = await store.prepareMutation(action, target).catch(failed);
      if (generation !== epoch.current) {
        if (!("kind" in value)) void window.harness.git.cancelMutation(value.token).catch(() => undefined);
        return;
      }
      if ("kind" in value) { setResult(value); setPhase(undefined); running.current = false; return; }
      if (action === "discard") { pending.current = value.token; setConfirmation(value); setPhase(undefined); }
      else await apply(value, generation);
    })();
  }, [store, apply]);
  const cancel = useCallback(() => {
    if (pending.current) void window.harness.git.cancelMutation(pending.current).catch(() => undefined);
    pending.current = undefined; setConfirmation(undefined); running.current = false;
  }, []);
  const confirm = () => { if (confirmation) void apply(confirmation, epoch.current); };
  const showRecoveries = useCallback(() => {
    if (!projectRoot) return;
    const generation = epoch.current;
    setRecoveryOpen(true); setRecoveries(undefined); setSelectedRecovery(undefined); setResult(undefined);
    void window.harness.git.listRecoveries(projectRoot).then((values) => { if (epoch.current === generation) setRecoveries(values); })
      .catch((error) => { if (epoch.current === generation) { setResult(failed(error)); setRecoveries([]); } });
  }, [projectRoot]);
  const recover = () => {
    if (!projectRoot || !selectedRecovery || running.current) return;
    running.current = true; setPhase("applying"); setResult(undefined);
    const generation = epoch.current;
    void window.harness.git.restoreRecovery(projectRoot, selectedRecovery.id).catch(failed).then(async (value) => {
      if (epoch.current !== generation) return;
      setResult(value); setPhase(undefined); running.current = false; store.refresh();
      if (value.kind === "applied") {
        setSelectedRecovery(undefined);
        const values = await window.harness.git.listRecoveries(projectRoot).catch(() => undefined);
        if (epoch.current === generation) setRecoveries(values);
      }
    });
  };
  return { phase, result, confirmation, cancel, confirm, onMutation, busy: Boolean(phase || confirmation),
    recoveryOpen, recoveries, selectedRecovery, setSelectedRecovery, recover, showRecoveries,
    closeRecoveries: () => { if (!phase) { setRecoveryOpen(false); setSelectedRecovery(undefined); } } };
}

function GitOperationError({ result }: { result?: GitMutationResult }) {
  const { t } = useI18n();
  if (result?.kind !== "error") return null;
  return <div className="workbench-operation-error" role="alert">
    <p>{t(`workbench.gitError.${result.error.code}`)}</p>
    <details><summary>{t("workbench.errorDetails")}</summary><pre>{result.error.details || result.error.message}</pre></details>
  </div>;
}
export function GitMutationNotice({ actions, onRefresh }: { actions: ReturnType<typeof useGitMutationActions>; onRefresh(): void }) {
  const { t } = useI18n();
  if (!actions.phase && !actions.result) return null;
  return <div className="workbench-mutation-notice" data-mutation-result={actions.result?.kind ?? actions.phase}>
    {actions.phase ? <p role="status">{t(actions.phase === "preparing" ? "workbench.mutationPreparing" : "workbench.mutationApplying")}</p>
      : actions.result?.kind === "error" ? <><GitOperationError result={actions.result} /><button type="button" onClick={onRefresh}>{t("workbench.refresh")}</button></>
        : actions.result?.kind === "applied" ? <p role="status">{t(`workbench.mutationDone.${actions.result.action}`)}</p> : null}
    {actions.result?.recovery && <button type="button" onClick={actions.showRecoveries}>{t("workbench.recoveries")}</button>}
  </div>;
}

function WorkbenchDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog className="workbench-dialog" ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>;
}
function Paths({ paths }: { paths: readonly string[] }) { return <ul className="workbench-confirm-paths">{paths.map((file) => <li key={file}><code>{file}</code></li>)}</ul>; }

export function GitMutationDialogs({ actions }: { actions: ReturnType<typeof useGitMutationActions> }) {
  const { t, locale } = useI18n();
  const { confirmation, selectedRecovery } = actions;
  if (confirmation) return <WorkbenchDialog title={t("workbench.confirmDiscard")} onClose={actions.cancel}>
    <p>{t(confirmation.scope === "unstaged" ? "workbench.discardUnstagedHint" : "workbench.discardStagedHint")}</p>
    {confirmation.hunkCount !== undefined && <p>{t("workbench.confirmHunks", { count: confirmation.hunkCount })}</p>}
    <Paths paths={confirmation.paths} />
    <div className="workbench-dialog-actions"><button autoFocus type="button" onClick={actions.cancel}>{t("workbench.cancel")}</button>
      <button type="button" className="is-destructive" onClick={actions.confirm}>{t("workbench.confirmRestore")}</button></div>
  </WorkbenchDialog>;
  if (!actions.recoveryOpen) return null;
  return <WorkbenchDialog title={t(selectedRecovery ? "workbench.confirmRecovery" : "workbench.recoveries")} onClose={actions.closeRecoveries}>
    <GitOperationError result={actions.result} />
    {selectedRecovery ? <><p>{t("workbench.recoveryConfirmHint")}</p><Paths paths={selectedRecovery.paths} />
      <div className="workbench-dialog-actions"><button type="button" disabled={Boolean(actions.phase)} onClick={() => actions.setSelectedRecovery(undefined)}>{t("workbench.back")}</button>
        <button type="button" disabled={Boolean(actions.phase)} onClick={actions.recover}>{t(actions.phase ? "workbench.mutationApplying" : "workbench.recover")}</button></div></>
      : <><p>{t("workbench.recoveryHint")}</p>
        {actions.recoveries === undefined ? <p role="status">{t("workbench.loading")}</p> : actions.recoveries.length === 0 ? <p>{t("workbench.noRecoveries")}</p>
          : <ol className="workbench-recovery-list">{actions.recoveries.map((record) => <li key={record.id} data-recovery-id={record.id}>
            <div><time>{new Date(record.createdAt).toLocaleString(locale)}</time><span>{t(`workbench.recovery.${record.status}`)}</span></div>
            <Paths paths={record.paths} />
            <button type="button" disabled={record.status === "restored" || record.status === "rolledBack"} onClick={() => { actions.setSelectedRecovery(record); }}>{t("workbench.recover")}</button>
          </li>)}</ol>}
        <div className="workbench-dialog-actions"><button autoFocus type="button" onClick={actions.closeRecoveries}>{t("workbench.close")}</button></div></>}
  </WorkbenchDialog>;
}
