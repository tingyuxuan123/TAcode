import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";
import { useBackdropClose } from "./use-backdrop-close";
import { useDialogFocus } from "./use-dialog-focus";

/** Portal avoids panel clipping; the caller persists optional "don't ask" choices. */
export function ConfirmDialog({ title, detail, confirmLabel, cancelLabel, alternateLabel, dontAskLabel, dontAsk, onDontAskChange, onConfirm, onCancel, onAlternate }: {
  title: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel: string;
  alternateLabel?: string;
  dontAskLabel?: string;
  dontAsk?: boolean;
  onDontAskChange?(next: boolean): void;
  onConfirm(): void;
  onCancel(): void;
  onAlternate?(): void;
}) {
  const titleId = useId();
  const detailId = useId();
  const focus = useDialogFocus(onCancel);
  const backdrop = useBackdropClose(onCancel);
  return createPortal(
    <div className="modal confirm-modal" {...focus} {...backdrop}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={detail ? detailId : undefined}>
        <h2 id={titleId}>{title}</h2>
        {detail && <p id={detailId}>{detail}</p>}
        {dontAskLabel && onDontAskChange && (
          <label className="modal-dont-ask">
            <input type="checkbox" checked={dontAsk ?? false} onChange={(event) => onDontAskChange(event.target.checked)} />
            <span>{dontAskLabel}</span>
          </label>
        )}
        <div className="row-actions">
          <button type="button" className="ghost" data-dialog-autofocus onClick={onCancel}>{cancelLabel}</button>
          {alternateLabel && onAlternate && <button type="button" className="ghost danger" onClick={onAlternate}>{alternateLabel}</button>}
          <button type="button" className="primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The owner saves first and runs the requested exit only after success. */
export function useUnsavedClose({ dirty, busy, onClose, onSave }: {
  dirty: boolean;
  busy?: boolean;
  onClose: () => void;
  onSave: (exit: () => void) => void;
}) {
  const { t } = useI18n();
  const [exit, setExit] = useState<(() => void) | null>(null);
  const requestLeave = (next: () => void) => {
    if (busy) return;
    if (dirty) setExit(() => next);
    else next();
  };
  return {
    requestClose: () => requestLeave(onClose),
    requestLeave,
    prompt: exit && <ConfirmDialog
      title={t("settings.unsavedTitle")}
      detail={t("settings.unsavedDetail")}
      cancelLabel={t("cap.keepEditing")}
      alternateLabel={t("cap.discard")}
      confirmLabel={t("settings.save")}
      onCancel={() => setExit(null)}
      onAlternate={() => { setExit(null); exit(); }}
      onConfirm={() => { setExit(null); onSave(exit); }}
    />,
  };
}
