import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Copy, ExternalLink, FilePlus2, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { isImeKey } from "../ime";
import { FileEditDialog, useFileEditing } from "./file-editing";
import { fileDocuments } from "./file-document-store";
import { pathWithin, type ExternalEditor, type FileEntry, type FileMutationRequest, type FileTarget } from "../../shared/files";
import { WorkbenchButton } from "./controls";
import type { SourceLocation } from "./types";

interface Command { id: string; label: string; icon: ReactNode; run(): void; dangerous?: boolean }
interface Menu { path: string; entryKind: FileEntry["kind"]; x: number; y: number; external?: boolean }
function FileActionMenu({ menu, commands, onClose }: { menu: Menu; commands: Command[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const element = ref.current!; element.showPopover();
    const rect = element.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x, innerWidth - rect.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - rect.height - 8)) });
    element.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (element.matches(":popover-open")) element.hidePopover(); };
  }, []);
  useLayoutEffect(() => {
    const element = ref.current!; const rect = element.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x, innerWidth - rect.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - rect.height - 8)) });
  }, [commands.length]);
  useEffect(() => { window.addEventListener("resize", onClose); return () => window.removeEventListener("resize", onClose); }, [onClose]);
  return <div ref={ref} popover="auto" className="file-action-menu" role="menu" style={position}
    onToggle={(event) => { if ((event.nativeEvent as ToggleEvent).newState === "closed") onClose(); }}
    onKeyDown={(event) => {
      if (isImeKey(event.nativeEvent)) return;
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button")]; const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : event.key === "ArrowUp" ? (current - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); }
    }}>
    {commands.map((command) => <button type="button" role="menuitem" data-file-action={command.id} key={command.id} className={command.dangerous ? "is-destructive" : ""}
      onClick={() => { onClose(); command.run(); }}>{command.icon}<span>{command.label}</span></button>)}
  </div>;
}
export function useFileActions(root: string, path: string | undefined, onOpen: (path: string, options?: { preview?: boolean; literal?: boolean }) => void, getLocation?: () => SourceLocation | undefined) {
  const { t } = useI18n(); const editing = useFileEditing();
  const [menu, setMenu] = useState<Menu>(); const previous = useRef<HTMLElement | undefined>(undefined);
  const [editors, setEditors] = useState<ExternalEditor[]>(["system"]);
  const [dialog, setDialog] = useState<{ operation: FileMutationRequest["operation"]; path: string; target?: FileTarget }>();
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [error, setError] = useState(""); const input = useRef<HTMLInputElement>(null); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { input.current?.select(); }, [dialog?.operation]);
  const report = (error: unknown) => { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); };
  const openMenu = (value: string, entryKind: FileEntry["kind"], x: number, y: number, external = false) => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setError(""); setMenu({ path: value, entryKind, x, y, external });
    void window.harness.files.editors().then((result) => { if (result.kind === "error") throw new Error(result.error.message); if (mounted.current) setEditors(result.editors); }).catch(report);
  };
  const closeMenu = () => { setMenu(undefined); if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }); };
  const start = (operation: FileMutationRequest["operation"], value: string, kind: FileEntry["kind"]) => {
    setError(""); const parent = kind === "directory" ? value : value.slice(0, Math.max(0, value.lastIndexOf("/")));
    setName(operation === "rename" ? value : parent ? `${parent}/` : "");
    setDialog({ operation, path: value });
    if (operation === "rename" || operation === "trash") void window.harness.files.inspect({ projectRoot: root, path: value }).then((target) => {
      if (target.kind === "error") throw new Error(target.error.message);
      if (mounted.current) setDialog((current) => current?.path === value && current.operation === operation ? { ...current, target } : current);
    }).catch(report);
  };
  const apply = async () => {
    if (!dialog || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); let unlock: (() => void) | undefined;
    try {
      const store = fileDocuments(); await store.waitForSaves();
      const structural = dialog.operation === "rename" || dialog.operation === "trash";
      if (structural) {
        unlock = store.lock(root, dialog.path);
        const before = await window.harness.files.inspect({ projectRoot: root, path: dialog.path });
        if (before.kind === "error") throw new Error(before.error.message);
        if (before.version !== dialog.target?.version) { setDialog({ ...dialog, target: before }); throw new Error(t("fileManage.changed")); }
        const affected = store.list(root).filter((state) => pathWithin(JSON.parse(state.key)[1], dialog.path)).map((state) => JSON.parse(state.key)[1] as string);
        if (!await editing.confirm(root, affected)) return;
        const after = await window.harness.files.inspect({ projectRoot: root, path: dialog.path });
        if (after.kind === "error") throw new Error(after.error.message);
        if (after.version !== before.version) { setDialog({ ...dialog, target: after }); throw new Error(t("fileManage.changed")); }
      }
      const value = structural ? dialog.path : name;
      const result = await store.trackOperation(window.harness.files.mutate({ projectRoot: root, path: value, operation: dialog.operation,
        destination: dialog.operation === "rename" ? name : undefined, expectedVersion: dialog.target?.version }));
      if (result.kind === "error") throw new Error(`${t("fileManage.failed")} ${result.error.message}`);
      setDialog(undefined);
      if (result.operation === "createFile") onOpen(result.path, { preview: false, literal: true });
    } catch (error) { report(error); }
    finally { unlock?.(); busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const action = async (value: string, operation: "relative" | "absolute" | "reveal" | ExternalEditor) => {
    let unlock: (() => void) | undefined;
    try {
      const request = { projectRoot: root, path: value };
      if (operation === "relative") { await navigator.clipboard.writeText(value); editing.notify("copyRelative", value); return; }
      if (operation === "absolute") { const result = await window.harness.files.location(request); if (result.kind === "error") throw new Error(result.error.message); await navigator.clipboard.writeText(result.absolutePath); editing.notify("copyAbsolute", result.absolutePath); return; }
      if (operation === "reveal") { const result = await window.harness.files.reveal(request); if (result.kind === "error") throw new Error(result.error.message); editing.notify("revealed", value || root); return; }
      const store = fileDocuments();
      unlock = store.lock(root, value);
      const affected = store.list(root).filter((state) => pathWithin(JSON.parse(state.key)[1], value)).map((state) => JSON.parse(state.key)[1] as string);
      if (!await editing.confirm(root, affected)) return;
      const result = await store.trackOperation(window.harness.files.open({ ...request, editor: operation, ...(value === path ? getLocation?.() : undefined) }));
      if (result.kind === "error") throw new Error(result.error.message);
      editing.notify("opened", value || root);
    } catch (error) { report(error); }
    finally { unlock?.(); }
  };
  const commands: Command[] = menu ? [
    { id: "createFile", label: t("fileManage.createFile"), icon: <FilePlus2 size={15} />, run: () => start("createFile", menu.path, menu.entryKind) },
    { id: "createDirectory", label: t("fileManage.createDirectory"), icon: <FolderPlus size={15} />, run: () => start("createDirectory", menu.path, menu.entryKind) },
    ...(menu.path ? [
      { id: "rename", label: t("fileManage.rename"), icon: <Pencil size={15} />, run: () => start("rename", menu.path, menu.entryKind) },
      { id: "trash", label: t("fileManage.trash"), icon: <Trash2 size={15} />, dangerous: true, run: () => start("trash", menu.path, menu.entryKind) },
      { id: "relative", label: t("fileManage.copyRelative"), icon: <Copy size={15} />, run: () => void action(menu.path, "relative") },
    ] : []),
    { id: "absolute", label: t("fileManage.copyAbsolute"), icon: <Copy size={15} />, run: () => void action(menu.path, "absolute") },
    { id: "reveal", label: t("fileManage.reveal"), icon: <FolderOpen size={15} />, run: () => void action(menu.path, "reveal") },
    ...editors.map((editor) => ({ id: editor, label: editor === "system" ? t("fileManage.system") : editor === "vscode" ? "VS Code" : "Cursor", icon: <ExternalLink size={15} />, run: () => void action(menu.path, editor) })),
  ] : [];
  const toolMenu = (event: React.MouseEvent<HTMLButtonElement>, external = false) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(path ?? "", path ? "file" : "directory", rect.left, rect.bottom + 4, external); };
  return { openMenu,
    copyRelative: () => { if (path) void action(path, "relative"); },
    toolbar: <WorkbenchButton label={t("fileManage.actions")} onClick={(event) => toolMenu(event)}><MoreHorizontal size={16} /></WorkbenchButton>,
    openButton: path ? <WorkbenchButton label={t("workbench.open")} className="has-label is-outlined" onClick={(event) => toolMenu(event, true)}><ExternalLink size={15} /><span>{t("workbench.open")}</span><ChevronDown size={12} /></WorkbenchButton> : undefined,
    create: (operation: "createFile" | "createDirectory") => start(operation, "", "directory"),
    overlays: <>{error && !dialog && <div className="file-action-error" role="alert">{error}</div>}{menu && <FileActionMenu menu={menu} commands={menu.external ? commands.filter((command) => ["system", "vscode", "cursor", "reveal"].includes(command.id)) : commands} onClose={closeMenu} />}
      {dialog && <FileEditDialog title={t(`fileManage.${dialog.operation}`)} onCancel={() => { if (!busyRef.current) { setDialog(undefined); setError(""); } }}>
        {dialog.operation === "trash" ? <p>{t("fileManage.trashConfirm")} <code>{dialog.path}</code></p> : <label className="file-name-label">{t("fileManage.path")}
          <input ref={input} autoFocus value={name} disabled={busy} data-file-name onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !isImeKey(event.nativeEvent)) { event.preventDefault(); void apply(); } }} /></label>}
        {error && <p role="alert">{error}</p>}
        <div className="workbench-dialog-actions"><button type="button" disabled={busy} onClick={() => { setDialog(undefined); setError(""); }}>{t("common.cancel")}</button>
          <button type="button" data-file-apply className={dialog.operation === "trash" ? "is-destructive" : "file-edit-save"}
            disabled={busy || (dialog.operation === "trash" || dialog.operation === "rename") && !dialog.target || dialog.operation !== "trash" && (!name || name.endsWith("/") || dialog.operation === "rename" && name === dialog.path)}
            onClick={() => void apply()}>{t(busy ? "fileManage.working" : `fileManage.${dialog.operation}`)}</button></div>
      </FileEditDialog>}</>,
  };
}
