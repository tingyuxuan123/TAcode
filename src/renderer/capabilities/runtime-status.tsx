import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CapabilityRuntimeStatus } from "../../shared/capabilities";
import { useI18n } from "../i18n";
import { errorText } from "./common";

/** Reports the current session only; opening this panel never starts a worker. */
export function CapabilityRuntime({ workspace, sessionPath, active }: { workspace?: string; sessionPath?: string; active: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CapabilityRuntimeStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const activation = useRef(0);
  const runtimeId = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const result = await window.harness.capabilities.runtimeStatus(workspace, sessionPath);
      if (seq !== sequence.current) return;
      runtimeId.current = result.runtimeId;
      setStatus(result);
      setError("");
    } catch (reason) { if (seq === sequence.current) setError(errorText(reason)); }
  }, [workspace, sessionPath]);
  useEffect(() => {
    if (!active) return;
    ++activation.current;
    setBusy(false);
    void refresh();
    const offConfig = window.harness.capabilities.onChanged((cwd) => { if (!cwd || cwd === workspace) void refresh(); });
    const offRuntime = window.harness.capabilities.onRuntimeChanged((id) => { if (!runtimeId.current || id === runtimeId.current) void refresh(); });
    const offAgent = window.harness.agent.onEvent((event) => {
      if (sessionPath === event.__sessionId && ["agent_start", "agent_settled", "desktop_runtime_stopped", "desktop_snapshot_meta"].includes(event.type)) void refresh();
    });
    return () => { ++sequence.current; ++activation.current; offConfig(); offRuntime(); offAgent(); };
  }, [active, refresh, workspace, sessionPath]);
  const reload = async () => {
    if (!status?.runtimeId) return;
    const epoch = activation.current;
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      await window.harness.capabilities.reloadRuntime(status.runtimeId);
      // Event updates may have advanced the sequence while reloading.
      if (activation.current === epoch && runtimeId.current === status.runtimeId) await refresh();
    } catch (reason) { if (seq === sequence.current) setError(errorText(reason)); }
    finally { if (activation.current === epoch) setBusy(false); }
  };
  const state = status?.state;
  const label = state === "inactive" ? t("cap.runtimeInactive") : state === "loaded" ? t("cap.runtimeLoaded")
    : state === "pending" ? t("cap.runtimePending") : state === "restart-required" ? t("cap.runtimeRestart")
      : state === "scheduled" ? t("cap.runtimeScheduled") : state === "reloading" ? t("cap.runtimeReloading")
        : state === "failed" ? t("cap.runtimeFailed") : t("cap.loading");
  return <div className="cap-runtime" data-state={state}>
    <div className="cap-runtime-row">
      <div role="status"><span>{label}</span>{state === "loaded" && status?.report && <small>{t("cap.runtimeCounts", { skills: status.report.skills.length, tools: status.report.mcpTools.length })}{status.report.permission === "plan" && ` · ${t("cap.runtimePlan")}`}</small>}</div>
      {status?.runtimeId && <button type="button" className="ghost" disabled={busy || state === "scheduled" || state === "reloading"} onClick={() => void reload()}><RefreshCw size={13} />{t("cap.runtimeReload")}</button>}
    </div>
    {(error || status?.error) && <p role="alert">{error || status?.error}<button type="button" className="cap-text-button" onClick={() => void refresh()}>{t("cap.retry")}</button></p>}
    {state === "loaded" && Boolean(status?.report?.mcpErrors.length) && <details className="cap-runtime-errors"><summary>{t("cap.runtimeMcpErrors")}</summary>{status!.report!.mcpErrors.map((message, index) => <p key={index}>{message}</p>)}</details>}
  </div>;
}
