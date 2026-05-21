import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AlertCircle,
  CheckCircle,
  ICON_DEFAULTS,
  Info,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "../lib/icons";
import type { CodeProject } from "../api";
import Modal from "./Modal";

interface Props {
  open: boolean;
  items: CodeProject[];
  activeId: number | null;
  onClose: () => void;
  onPick: (id: number) => void;
  onNew: () => void;
  onEdit: (cp: CodeProject) => void;
  onDelete: (cp: CodeProject) => void;
}

/**
 * Modal listing every code project inside the current Bunny project. Pick,
 * add, edit, or soft-delete from one place. Opened from the rail picker at
 * the top of `CodeRail`.
 */
export default function CodeProjectPickerDialog({
  open,
  items,
  activeId,
  onClose,
  onPick,
  onNew,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <Modal onClose={onClose}>
      <Modal.Header title={t("dialog.codePicker.title")} />
      <div className="code-picker">
        <div className="code-picker__header">
          <button type="button" className="btn btn--primary" onClick={onNew}>
            <Plus size={14} /> {t("dialog.codePicker.new")}
          </button>
        </div>
        <ul className="code-picker__list">
          {items.length === 0 && (
            <li className="code-picker__empty">{t("dialog.codePicker.empty")}</li>
          )}
          {items.map((cp) => {
            const isActive = cp.id === activeId;
            return (
              <li
                key={cp.id}
                className={`code-picker__row ${isActive ? "code-picker__row--active" : ""}`}
              >
                <button
                  type="button"
                  className="code-picker__pick"
                  onClick={() => onPick(cp.id)}
                >
                  <span className="code-picker__name">{cp.name}</span>
                  {cp.description && (
                    <span className="code-picker__desc">{cp.description}</span>
                  )}
                </button>
                <span className="code-picker__status">
                  <PickerStatusIcon status={cp.gitStatus} t={t} />
                </span>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => onEdit(cp)}
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => onDelete(cp)}
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <Modal.Footer>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          {t("common.close")}
        </button>
      </Modal.Footer>
    </Modal>
  );
}

function PickerStatusIcon({
  status,
  t,
}: {
  status: CodeProject["gitStatus"];
  t: TFunction;
}) {
  if (status === "cloning")
    return (
      <span className="status-dot status-dot--busy" title={t("dialog.codePicker.status.cloning")}>
        <Loader2 {...ICON_DEFAULTS} size={14} />
      </span>
    );
  if (status === "error")
    return (
      <span className="status-dot status-dot--err" title={t("dialog.codePicker.status.error")}>
        <AlertCircle size={14} />
      </span>
    );
  if (status === "ready")
    return (
      <span className="status-dot status-dot--ok" title={t("dialog.codePicker.status.ready")}>
        <CheckCircle size={14} />
      </span>
    );
  return (
    <span className="status-dot" title={t("dialog.codePicker.status.idle")}>
      <Info size={14} />
    </span>
  );
}
