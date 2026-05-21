import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWhiteboards, type WhiteboardSummary } from "../api";
import Modal from "./Modal";

interface Props {
  project: string;
  onPick: (whiteboardId: number, mode: "live" | "static") => void;
  onClose: () => void;
}

export default function WhiteboardPickerDialog({
  project,
  onPick,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetchWhiteboards(project)
      .then(setWhiteboards)
      .finally(() => setLoading(false));
  }, [project]);

  return (
    <Modal onClose={onClose}>
      <Modal.Header title={t("dialog.whiteboardPicker.title")} />
      {loading ? (
        <p style={{ padding: 16, color: "var(--text-dim)" }}>
          {t("dialog.whiteboardPicker.loading")}
        </p>
      ) : whiteboards.length === 0 ? (
        <p style={{ padding: 16, color: "var(--text-dim)" }}>
          {t("dialog.whiteboardPicker.empty")}
        </p>
      ) : (
        <ul className="wb-picker__list">
          {whiteboards.map((wb) => (
            <li key={wb.id} className="wb-picker__item">
              <div className="wb-picker__info">
                {wb.thumbnail && (
                  <img src={wb.thumbnail} alt="" className="wb-picker__thumb" />
                )}
                <span className="wb-picker__name">{wb.name}</span>
              </div>
              <div className="wb-picker__actions">
                <button
                  className="btn btn--sm"
                  onClick={() => onPick(wb.id, "live")}
                  title={t("dialog.whiteboardPicker.liveTitle")}
                >
                  {t("dialog.whiteboardPicker.liveBtn")}
                </button>
                <button
                  className="btn btn--sm"
                  onClick={() => onPick(wb.id, "static")}
                  title={t("dialog.whiteboardPicker.staticTitle")}
                >
                  {t("dialog.whiteboardPicker.staticBtn")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal.Footer>
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
