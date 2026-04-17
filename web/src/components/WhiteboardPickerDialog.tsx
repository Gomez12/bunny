import { useEffect, useState } from "react";
import { fetchWhiteboards, type WhiteboardSummary } from "../api";

interface Props {
  project: string;
  onPick: (whiteboardId: number, mode: "live" | "static") => void;
  onClose: () => void;
}

export default function WhiteboardPickerDialog({ project, onPick, onClose }: Props) {
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetchWhiteboards(project)
      .then(setWhiteboards)
      .finally(() => setLoading(false));
  }, [project]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h2 className="dialog__title">Insert Whiteboard</h2>
        {loading ? (
          <p style={{ padding: 16, color: "var(--text-dim)" }}>Loading...</p>
        ) : whiteboards.length === 0 ? (
          <p style={{ padding: 16, color: "var(--text-dim)" }}>No whiteboards in this project yet.</p>
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
                    title="Updates automatically when the whiteboard changes"
                  >
                    Live
                  </button>
                  <button
                    className="btn btn--sm"
                    onClick={() => onPick(wb.id, "static")}
                    title="Snapshot — frozen at insert time"
                  >
                    Static
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="dialog__actions">
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
