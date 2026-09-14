import { useState } from "react";
import { useI18n } from "../i18n";

/** Agent plan/undo belongs to the conversation; Git scope never controls it. */
export function SessionReviewActions({ planApproval, canUndo, onApprovePlan, onRefinePlan, onUndo }: {
  planApproval: boolean;
  canUndo: boolean;
  onApprovePlan(): void;
  onRefinePlan(text: string): void;
  onUndo(): void;
}) {
  const { t } = useI18n();
  const [refineOpen, setRefineOpen] = useState(false);
  const [text, setText] = useState("");
  if (!planApproval && !canUndo) return null;
  return <div className="session-review-actions">
    {planApproval && <div className="plan-approval">
      <p>{t("plan.approvalHint")}</p>
      <div className="plan-approval-actions">
        <button type="button" className="primary" onClick={onApprovePlan}>{t("plan.approve")}</button>
        <button type="button" className="ghost" onClick={() => setRefineOpen(!refineOpen)}>{t("plan.refine")}</button>
      </div>
      {refineOpen && <div className="plan-refine">
        <textarea aria-label={t("plan.refinePlaceholder")} placeholder={t("plan.refinePlaceholder")} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="button" className="ghost" disabled={!text.trim()} onClick={() => { if (text.trim()) { onRefinePlan(text.trim()); setText(""); setRefineOpen(false); } }}>{t("plan.refineSubmit")}</button>
      </div>}
    </div>}
    {canUndo && <button type="button" className="inspect-undo" onClick={onUndo}>{t("inspect.undo")}</button>}
  </div>;
}
