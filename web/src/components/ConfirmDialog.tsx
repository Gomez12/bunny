import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";

interface Props {
  open: boolean;
  /** Optional heading. When omitted, the dialog is headerless (no X close —
   * ESC, backdrop, and the Cancel button still dismiss). */
  title?: string;
  message: ReactNode;
  /** Override the default localised "OK". */
  confirmLabel?: string;
  /** Override the default localised "Cancel". */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  const resolvedConfirm = confirmLabel ?? t("common.ok");
  const resolvedCancel = cancelLabel ?? t("common.cancel");
  return (
    <Modal onClose={onCancel}>
      {title && <Modal.Header title={title} />}
      <p style={{ margin: "0 0 16px", lineHeight: 1.5 }}>{message}</p>
      <Modal.Footer>
        <button type="button" className="btn" onClick={onCancel}>
          {resolvedCancel}
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm}>
          {resolvedConfirm}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
