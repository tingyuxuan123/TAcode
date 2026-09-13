import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Search, ShieldCheck, X } from "lucide-react";
import type { CapabilityScope } from "../../shared/capabilities";
import { useI18n } from "../i18n";
import { ConfirmDialog } from "../ui";

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export function useCapabilityData<T>(load: () => Promise<T>, workspace?: string) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const value = await load();
      if (current === sequence.current) { setData(value); setError(""); }
      return value;
    } catch (reason) {
      if (current === sequence.current) setError(errorText(reason));
      return undefined;
    } finally { if (current === sequence.current) setLoading(false); }
  }, [load]);
  useEffect(() => {
    void refresh();
    const off = window.harness.capabilities.onChanged((cwd) => {
      if (!cwd || cwd === workspace) void refresh();
    });
    return () => { sequence.current += 1; off(); };
  }, [refresh, workspace]);
  return { data, loading, error, refresh, setError };
}

export function CapabilityScopePicker({ scope, workspace, onChange }: { scope: CapabilityScope; workspace?: string; onChange(scope: CapabilityScope): void }) {
  const { t } = useI18n();
  return <select className="cap-scope" aria-label={t("cap.scope")} value={scope} onChange={(event) => onChange(event.target.value as CapabilityScope)}>
    {workspace && <option value="project">{t("cap.project")}</option>}
    <option value="user">{t("cap.user")}</option>
  </select>;
}

export function CapabilitySearch({ value, onChange, placeholder }: { value: string; onChange(value: string): void; placeholder: string }) {
  const { t } = useI18n();
  return <div className="cap-search"><Search size={15} /><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    {value && <button type="button" className="cap-icon-button" aria-label={t("cap.clearSearch")} onClick={() => onChange("")}><X size={13} /></button>}
  </div>;
}

export function CapabilitySwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange(checked: boolean): void; label: string; disabled?: boolean }) {
  return <button type="button" className="cap-switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function CapabilityNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`cap-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{children}</div>;
}

export function CapabilitySkeleton({ label }: { label: string }) {
  return <div className="cap-skeleton" role="status" aria-label={label}>
    {[0, 1, 2].map((index) => <div className="cap-skeleton-card" key={index} aria-hidden>
      <div className="cap-skeleton-head"><span className="cap-skeleton-icon" /><span className="cap-skeleton-line" style={{ width: "42%" }} /></div>
      <span className="cap-skeleton-line" style={{ width: "94%" }} />
      <span className="cap-skeleton-line" style={{ width: "63%" }} />
    </div>)}
  </div>;
}

export function CapabilityTrust({ trusted, workspace, onTrusted }: { trusted: boolean; workspace?: string; onTrusted(): void }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (trusted || !workspace) return null;
  return <>
    <div className="cap-trust"><ShieldCheck size={17} /><p>{t("cap.trustHint")}</p><button type="button" className="ghost" onClick={() => setConfirm(true)} disabled={busy}>{t("cap.trust")}</button></div>
    {error && <CapabilityNotice error>{error}</CapabilityNotice>}
    {confirm && <ConfirmDialog title={t("cap.trustTitle")} detail={t("cap.trustDetail")} confirmLabel={t("cap.trust")} cancelLabel={t("cap.cancel")}
      onCancel={() => setConfirm(false)} onConfirm={() => {
        setConfirm(false); setBusy(true);
        void window.harness.capabilities.trustProject(workspace).then(onTrusted).catch((reason) => setError(errorText(reason))).finally(() => setBusy(false));
      }} />}
  </>;
}

export function CapabilityBack({ title, dirty, onBack }: { title: string; dirty: boolean; onBack(): void }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  return <>
    <div className="cap-detail-heading"><button type="button" className="cap-icon-button" aria-label={t("cap.back")} onClick={() => dirty ? setConfirm(true) : onBack()}><ArrowLeft size={18} /></button><h2>{title}</h2></div>
    {confirm && <ConfirmDialog title={t("cap.discardTitle")} detail={t("cap.discardDetail")} confirmLabel={t("cap.discard")} cancelLabel={t("cap.keepEditing")} onConfirm={onBack} onCancel={() => setConfirm(false)} />}
  </>;
}

export function useDirty(dirty: boolean, onDirtyChange?: (dirty: boolean) => void): void {
  const latest = useRef(onDirtyChange);
  latest.current = onDirtyChange;
  useEffect(() => { latest.current?.(dirty); return () => latest.current?.(false); }, [dirty]);
}
