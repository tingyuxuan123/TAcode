import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { GitCommitAction, GitCommitInfo, GitCommitPreview, GitCommitResult, GitCommitTarget } from "../../shared/git";
import { useI18n } from "../i18n";
import type { GitReviewStore } from "./git-review-store";

type Phase = "loading" | "preparing" | "applying" | undefined;
const failed = (error: unknown): GitCommitResult => ({ kind: "error", error: { code: "failed", message: error instanceof Error ? error.message : String(error) } });

export function useGitCommitActions(store: GitReviewStore, projectRoot: string | undefined, comparisonKey: string) {
  const epoch = useRef(0);
  const running = useRef(false);
  const pending = useRef<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<GitCommitInfo>();
  const [action, setAction] = useState<GitCommitAction>("commit");
  const [message, setMessage] = useState("");
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [preview, setPreview] = useState<GitCommitPreview>();
  const [result, setResult] = useState<GitCommitResult>();
  useEffect(() => {
    epoch.current++;
    running.current = false; pending.current = undefined; setOpen(false); setInfo(undefined); setPreview(undefined); setResult(undefined); setPhase(undefined); setMessage("");
    return () => {
      epoch.current++;
      if (pending.current) void window.harness.git.cancelCommit(pending.current).catch(() => undefined);
      pending.current = undefined;
    };
  }, [comparisonKey, projectRoot]);

  const close = useCallback(() => {
    epoch.current++;
    if (pending.current) void window.harness.git.cancelCommit(pending.current).catch(() => undefined);
    pending.current = undefined; running.current = false; setOpen(false); setInfo(undefined); setPreview(undefined); setPhase(undefined);
  }, []);
  const openDialog = useCallback(() => {
    if (!projectRoot || running.current) return;
    const generation = ++epoch.current;
    running.current = true; setOpen(true); setPhase("loading"); setResult(undefined); setPreview(undefined); setInfo(undefined);
    void store.getCommitInfo().then((value) => {
      if (generation !== epoch.current) return;
      if ("kind" in value) { setResult(value); setPhase(undefined); running.current = false; return; }
      const preferred = value.hasStaged ? (value.upstreamTarget ? "commitAndPush" : "commit") : "push";
      setInfo(value); setAction(preferred); setRemote(value.upstreamTarget?.remote ?? value.remotes[0]?.name ?? ""); setBranch(value.upstreamTarget?.branch ?? value.branch ?? ""); setPhase(undefined); running.current = false;
    }).catch((error) => { if (generation === epoch.current) { setResult(failed(error)); setPhase(undefined); running.current = false; } });
  }, [projectRoot, store]);

  const prepare = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (running.current || !info) return;
    running.current = true; setPhase("preparing"); setResult(undefined);
    const generation = epoch.current;
    const target: GitCommitTarget | undefined = action === "commit" ? undefined : { remote, branch };
    void store.prepareCommit(action, action === "push" ? undefined : message, target).then((value) => {
      if (generation !== epoch.current) {
        if (!("kind" in value)) void window.harness.git.cancelCommit(value.token).catch(() => undefined);
        return;
      }
      if ("kind" in value) { setResult(value); setPhase(undefined); running.current = false; return; }
      pending.current = value.token; setPreview(value); setPhase(undefined); running.current = false;
    }).catch((error) => { if (generation === epoch.current) { setResult(failed(error)); setPhase(undefined); running.current = false; } });
  }, [action, branch, info, message, remote, store]);

  const apply = useCallback(() => {
    if (!preview || running.current) return;
    running.current = true; setPhase("applying"); setResult(undefined);
    const generation = epoch.current; const token = preview.token;
    void window.harness.git.applyCommit(token).catch(failed).then((value) => {
      if (generation !== epoch.current) return;
      pending.current = undefined;
      setResult(value); setPreview(undefined); setPhase(undefined); running.current = false; store.refresh();
      if (value.kind === "applied") setOpen(false);
      if (value.kind === "applied") void store.getCommitInfo().then((next) => { if (generation === epoch.current && !((next as { kind?: string }).kind)) setInfo(next as GitCommitInfo); }).catch(() => undefined);
    });
  }, [preview, store]);

  const cancel = useCallback(() => {
    const token = pending.current;
    if (token) void window.harness.git.cancelCommit(token).catch(() => undefined);
    pending.current = undefined; setPreview(undefined); setPhase(undefined); running.current = false;
  }, []);
  const cancelRunning = useCallback(() => {
    const token = preview?.token ?? pending.current;
    if (token) void window.harness.git.cancelCommit(token).catch(() => undefined);
  }, [preview]);
  return { open, info, action, setAction, message, setMessage, remote, setRemote, branch, setBranch, phase, preview, result,
    openDialog, close, prepare, apply, cancel, cancelRunning, busy: Boolean(open || phase || preview) };
}

function CommitDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog className="workbench-dialog workbench-commit-dialog" ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>;
}

function ErrorNotice({ result }: { result?: GitCommitResult }) {
  const { t } = useI18n();
  if (result?.kind !== "error") return null;
  return <div className="workbench-operation-error" role="alert"><p>{t(`workbench.gitError.${result.error.code}`)}</p>
    <details><summary>{t("workbench.errorDetails")}</summary><pre>{result.error.details || result.error.message}</pre></details>
    {result.commit && <p>{t("workbench.commitPartial")}</p>}</div>;
}

function Paths({ paths }: { paths: readonly string[] }) { return <ul className="workbench-confirm-paths">{paths.map((file) => <li key={file}><code>{file}</code></li>)}</ul>; }

export function GitCommitNotice({ actions }: { actions: ReturnType<typeof useGitCommitActions> }) {
  const { t } = useI18n();
  if (!actions.result || actions.open) return null;
  if (actions.result.kind === "error") return <div className="workbench-mutation-notice" data-commit-result="error"><ErrorNotice result={actions.result} /></div>;
  return <div className="workbench-mutation-notice" data-commit-result="applied" role="status"><p>{t(`workbench.commitDone.${actions.result.action}`)}</p></div>;
}

export function GitCommitDialogs({ actions }: { actions: ReturnType<typeof useGitCommitActions> }) {
  const { t } = useI18n();
  if (!actions.open) return null;
  const info = actions.info;
  return <CommitDialog title={t("workbench.commitTitle")} onClose={actions.phase === "applying" ? actions.cancelRunning : actions.close}>
    {actions.phase === "loading" ? <p role="status">{t("workbench.loading")}</p> : actions.preview ? <>
      <p>{t(actions.preview.action === "commit" ? "workbench.confirmCommit" : actions.preview.action === "push" ? "workbench.confirmPush" : "workbench.confirmCommitAndPush")}</p>
      <p>{t("workbench.stagedSummary", { count: actions.preview.stagedPaths.length, additions: actions.preview.stagedAdditions, deletions: actions.preview.stagedDeletions })}</p>
      {actions.preview.message && <pre className="workbench-commit-message">{actions.preview.message}</pre>}
      {actions.preview.target && <p>{t("workbench.pushTargetSummary", { remote: actions.preview.target.remote, branch: actions.preview.target.branch })}</p>}
      <Paths paths={actions.preview.stagedPaths} />
      <ErrorNotice result={actions.result} />
      <div className="workbench-dialog-actions"><button autoFocus type="button" onClick={actions.phase === "applying" ? actions.cancelRunning : actions.cancel}>{t("workbench.cancel")}</button>
        <button type="button" className="is-destructive" disabled={actions.phase === "applying"} onClick={actions.apply}>{t(actions.phase === "applying" ? "workbench.commitApplying" : "workbench.confirmCommitAction")}</button></div>
    </> : info ? <form onSubmit={actions.prepare}>
      <p>{t("workbench.branchSummary", { branch: info.branch ?? t("workbench.unbornBranch"), upstream: info.upstream ?? t("workbench.noUpstreamShort") })}</p>
      <p>{t("workbench.stagedSummary", { count: info.stagedPaths.length, additions: info.stagedAdditions, deletions: info.stagedDeletions })}</p>
      {info.stagedPaths.length > 0 && <Paths paths={info.stagedPaths} />}
      <label>{t("workbench.commitAction")}<select value={actions.action} onChange={(event) => actions.setAction(event.target.value as GitCommitAction)}>
        <option value="commit">{t("workbench.actionCommit")}</option><option value="push">{t("workbench.actionPush")}</option><option value="commitAndPush">{t("workbench.actionCommitAndPush")}</option>
      </select></label>
      {actions.action !== "push" && <label>{t("workbench.commitMessage")}<textarea required rows={4} maxLength={10_000} value={actions.message} onChange={(event) => actions.setMessage(event.target.value)} placeholder={t("workbench.commitPlaceholder")} /></label>}
      {actions.action !== "commit" && <div className="workbench-commit-target"><label>{t("workbench.pushRemote")}<select required value={actions.remote} onChange={(event) => actions.setRemote(event.target.value)}>
        <option value="">{t("workbench.chooseRemote")}</option>{info.remotes.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select></label><label>{t("workbench.pushBranch")}<input required maxLength={1024} value={actions.branch} onChange={(event) => actions.setBranch(event.target.value)} /></label></div>}
      <ErrorNotice result={actions.result} />
      <div className="workbench-dialog-actions"><button type="button" onClick={actions.close}>{t("workbench.close")}</button><button type="submit" className="is-destructive" disabled={actions.phase === "preparing" || (actions.action !== "push" && !actions.message.trim())}>{t(actions.phase === "preparing" ? "workbench.commitPreparing" : "workbench.prepareCommit")}</button></div>
    </form> : <ErrorNotice result={actions.result} />}
  </CommitDialog>;
}
