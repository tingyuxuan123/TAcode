import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { FileMutation, ProjectPath } from "../../shared/files";
import { fileDocuments, useFileDocuments } from "./file-document-store";
import { isImeKey } from "../ime";
import { applyFileMutationToStorage } from "./file-view-state";

export function FileEditDialog({ title, onCancel, children, className = "" }: { title: string; onCancel(): void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`workbench-dialog file-edit-dialog ${className}`} aria-label={title}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}><h2>{title}</h2>{children}</dialog>;
}
type Confirm = (root?: string, paths?: readonly string[], retain?: boolean) => Promise<boolean>;
type ActionNotice = "copyRelative" | "copyAbsolute" | "opened" | "revealed";
type Notice = Pick<FileMutation, "operation" | "path" | "destination"> | { operation: ActionNotice; path: string; destination?: undefined };
const FileEditingContext = createContext<{ confirm: Confirm; notify(operation: ActionNotice, path: string): void }>({ notify: () => {}, confirm: async (root, paths) => {
  const store = fileDocuments(); if (store.dirty(root, paths).length) return false; await store.flush(); return true;
} });
export const useFileEditing = () => useContext(FileEditingContext);

export function FileEditingProvider({ children }: { children: ReactNode }) {
  const store = useFileDocuments(); const { t } = useI18n();
  const pending = useRef<{ promise: Promise<boolean>; resolve(allow: boolean): void } | undefined>(undefined);
  const [selection, setSelection] = useState<{ root?: string; paths?: readonly string[]; retain: boolean; files: ProjectPath[] }>();
  const [busy, setBusy] = useState(false); const busyRef = useRef(false); const [error, setError] = useState("");
  const permitUnload = useRef(false);
  const [notice, setNotice] = useState<Notice>();
  const notify = useCallback((operation: ActionNotice, path: string) => setNotice({ operation, path }), []);
  useEffect(() => window.harness.files.onMutation?.((mutation) => {
    applyFileMutationToStorage(mutation); store.applyMutation(mutation);
    setNotice(mutation);
  }), [store]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(undefined), 6000); return () => clearTimeout(timer); } }, [notice]);
  const confirm = useCallback<Confirm>(async (root, paths, retain = false) => {
    await store.waitForSaves();
    if (pending.current) return false;
    const files = store.dirty(root, paths); let checkpointError = "";
    if (!files.length) { try { await store.flush(); return true; } catch (error) { checkpointError = String(error); } }
    let resolve!: (allow: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; }); pending.current = { promise, resolve };
    setSelection({ root, paths, retain, files }); setError(checkpointError); return promise;
  }, [store]);
  const value = useMemo(() => ({ confirm, notify }), [confirm, notify]);
  const finish = (allow: boolean) => { const current = pending.current; pending.current = undefined; setSelection(undefined); setError(""); current?.resolve(allow); };
  const apply = async (action: "save" | "discard" | "retain") => {
    if (!selection || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const files = store.dirty(selection.root, selection.paths);
      for (const file of files) {
        if (action === "save" && !await store.save(file.projectRoot, file.path)) throw new Error(t("fileEdit.saveFailed"));
        if (action === "discard") await store.discard(file.projectRoot, file.path);
      }
      await store.flush();
      if (action !== "retain" && store.dirty(selection.root, selection.paths).length) throw new Error(t("fileEdit.newChanges"));
      finish(true);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    const api = window.harness.window;
    const off = api.onCloseRequest?.(({ id }) => { void confirm(undefined, undefined, true).then((allow) => { permitUnload.current = allow; api.answerCloseRequest(id, allow); }); });
    api.setCloseGuardReady?.(true);
    const reload = (event: KeyboardEvent) => {
      if (isImeKey(event) || !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") && event.key !== "F5") return;
      event.preventDefault(); event.stopImmediatePropagation();
      void confirm(undefined, undefined, true).then((allow) => { if (allow) { permitUnload.current = true; location.reload(); } });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (permitUnload.current || !store.hasPendingChanges()) return;
      event.preventDefault(); event.returnValue = "";
      void confirm(undefined, undefined, true).then((allow) => { if (allow) { permitUnload.current = true; location.reload(); } });
    };
    window.addEventListener("keydown", reload, true);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { off?.(); api.setCloseGuardReady?.(false); window.removeEventListener("keydown", reload, true); window.removeEventListener("beforeunload", beforeUnload); pending.current?.resolve(false); pending.current = undefined; };
  }, [confirm]);
  return <FileEditingContext.Provider value={value}>{children}{notice && <div className="file-mutation-status" role="status">{t(`fileManage.done.${notice.operation}`)} {notice.destination ?? notice.path}</div>}{selection && <FileEditDialog title={t("fileEdit.unsavedTitle")} onCancel={() => { if (!busyRef.current) finish(false); }}>
    <ul className="workbench-confirm-paths">{selection.files.map((file) => <li key={JSON.stringify(file)}><code title={file.projectRoot}>{file.path}</code>
      {store.snapshot(file.projectRoot, file.path).saveError && <span>{t("fileEdit.saveFailed")}</span>}</li>)}</ul>
    {error && <p role="alert">{error}</p>}
    <div className="workbench-dialog-actions"><button autoFocus type="button" disabled={busy} onClick={() => finish(false)}>{t("common.cancel")}</button>
      <button type="button" className="is-destructive" disabled={busy} onClick={() => void apply("discard")}>{t("fileEdit.discard")}</button>
      {selection.retain && <button type="button" disabled={busy} onClick={() => void apply("retain")}>{t("fileEdit.retain")}</button>}
      <button type="button" className="file-edit-save" disabled={busy} onClick={() => void apply("save")}>{t(busy ? "fileEdit.saving" : "fileEdit.saveAll")}</button></div>
  </FileEditDialog>}</FileEditingContext.Provider>;
}
