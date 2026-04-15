import type { BoardCard as BoardCardModel, Swimlane } from "../api";

interface Props {
  card: BoardCardModel;
  lanes: Swimlane[];
  canEdit: boolean;
  onEdit: () => void;
  onMove: (toLaneId: number) => void;
  onArchive: () => void;
}

export default function BoardCard({ card, lanes, canEdit, onEdit, onMove, onArchive }: Props) {
  const otherLanes = lanes.filter((l) => l.id !== card.swimlaneId);
  return (
    <div className="board-card">
      <button className="board-card__title" onClick={onEdit} disabled={!canEdit} title="Edit card">
        {card.title}
      </button>
      {card.description && <p className="board-card__desc">{card.description}</p>}
      <div className="board-card__meta">
        {card.assigneeAgent && (
          <span className="board-card__assignee board-card__assignee--agent">
            @{card.assigneeAgent}
          </span>
        )}
        {card.assigneeUserId && !card.assigneeAgent && (
          <span className="board-card__assignee board-card__assignee--user">
            👤 {card.assigneeUserId.slice(0, 8)}
          </span>
        )}
        {!card.assigneeAgent && !card.assigneeUserId && (
          <span className="board-card__assignee board-card__assignee--none">unassigned</span>
        )}
      </div>
      {canEdit && (
        <div className="board-card__actions">
          {otherLanes.length > 0 && (
            <select
              className="board-card__move"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) onMove(Number(v));
              }}
            >
              <option value="">Move…</option>
              {otherLanes.map((l) => (
                <option key={l.id} value={l.id}>
                  → {l.name}
                </option>
              ))}
            </select>
          )}
          <button className="board-card__archive" onClick={onArchive} title="Archive card">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
