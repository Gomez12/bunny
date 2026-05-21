import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "../lib/icons";
import type { PlanningProject } from "../api";
import Modal from "./Modal";

interface Props {
  open: boolean;
  items: PlanningProject[];
  activeId: number | null;
  onClose: () => void;
  onPick: (id: number) => void;
  onNew: () => void;
  onEdit: (pp: PlanningProject) => void;
  onDelete: (pp: PlanningProject) => void;
}

export default function PlanningProjectPickerDialog({
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
      <Modal.Header title={t("dialog.planningPicker.title")} />
      <div className="code-picker">
        <div className="code-picker__header">
          <button type="button" className="btn btn--primary" onClick={onNew}>
            <Plus size={14} /> {t("dialog.planningPicker.new")}
          </button>
        </div>
        <ul className="code-picker__list">
          {items.length === 0 && (
            <li className="code-picker__empty">{t("dialog.planningPicker.empty")}</li>
          )}
          {items.map((pp) => {
            const isActive = pp.id === activeId;
            return (
              <li
                key={pp.id}
                className={`code-picker__row ${isActive ? "code-picker__row--active" : ""}`}
              >
                <button
                  type="button"
                  className="code-picker__pick"
                  onClick={() => onPick(pp.id)}
                >
                  <span className="code-picker__name">{pp.name}</span>
                  {pp.description && (
                    <span className="code-picker__desc">{pp.description}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => onEdit(pp)}
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => onDelete(pp)}
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
