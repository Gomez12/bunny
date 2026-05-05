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
  if (!open) return null;
  return (
    <Modal onClose={onClose}>
      <Modal.Header title="Code projects" />
      <div className="code-picker">
        <div className="code-picker__header">
          <button type="button" className="btn btn--primary" onClick={onNew}>
            <Plus size={14} /> New
          </button>
        </div>
        <ul className="code-picker__list">
          {items.length === 0 && (
            <li className="code-picker__empty">
              No code projects yet. Add one to get started.
            </li>
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
                  <PickerStatusIcon status={cp.gitStatus} />
                </span>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => onEdit(cp)}
                  title="Edit"
                  aria-label="Edit"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => onDelete(cp)}
                  title="Delete"
                  aria-label="Delete"
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
          Close
        </button>
      </Modal.Footer>
    </Modal>
  );
}

function PickerStatusIcon({ status }: { status: CodeProject["gitStatus"] }) {
  if (status === "cloning")
    return (
      <span className="status-dot status-dot--busy" title="Cloning">
        <Loader2 {...ICON_DEFAULTS} size={14} />
      </span>
    );
  if (status === "error")
    return (
      <span className="status-dot status-dot--err" title="Clone failed">
        <AlertCircle size={14} />
      </span>
    );
  if (status === "ready")
    return (
      <span className="status-dot status-dot--ok" title="Ready">
        <CheckCircle size={14} />
      </span>
    );
  return (
    <span className="status-dot" title="Idle">
      <Info size={14} />
    </span>
  );
}
