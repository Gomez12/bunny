import type { ReactNode } from "react";
import Modal from "./Modal";

interface Props {
  open: boolean;
  /** Optional heading. When omitted, the dialog is headerless (no X close —
   * ESC, backdrop, and the Cancel button still dismiss). */
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  return (
    <Modal onClose={onCancel}>
      {title && <Modal.Header title={title} />}
      <p style={{ margin: "0 0 16px", lineHeight: 1.5 }}>{message}</p>
      <Modal.Footer>
        <button type="button" className="btn" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
