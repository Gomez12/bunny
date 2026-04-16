import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardCard as BoardCardModel, Swimlane } from "../api";

interface Props {
  card: BoardCardModel;
  lanes: Swimlane[];
  canEdit: boolean;
  onEdit: () => void;
  onMove: (toLaneId: number) => void;
  onArchive: () => void;
}

type CardVisualStatus = "idle" | "pending" | "running" | "answered" | "errored";

function cardStatus(card: BoardCardModel): CardVisualStatus {
  if (card.latestRunStatus === "running" || card.latestRunStatus === "queued") return "running";
  if (card.latestRunStatus === "error") return "errored";
  if (card.latestRunStatus === "done") return "answered";
  if (card.autoRun) return "pending";
  return "idle";
}

/**
 * Presentational card body — shared between the sortable card in a column and
 * the floating `DragOverlay` preview that follows the cursor.
 */
function CardBody({ card }: { card: BoardCardModel }) {
  const status = cardStatus(card);
  return (
    <>
      <div className="board-card__title board-card__title--static">{card.title}</div>
      {card.description && <p className="board-card__desc">{card.description}</p>}
      {(card.estimateHours != null || card.percentDone != null) && (
        <div className="board-card__progress">
          {card.estimateHours != null && (
            <span className="board-card__estimate">{card.estimateHours}h</span>
          )}
          {card.percentDone != null && (
            <span className="board-card__pct">{card.percentDone}%</span>
          )}
          {card.percentDone != null && (
            <div className="board-card__bar">
              <div className="board-card__bar-fill" style={{ width: `${card.percentDone}%` }} />
            </div>
          )}
        </div>
      )}
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
        {card.autoRun && (
          <span className="board-card__badge board-card__badge--auto" title="Auto-run pending">
            ⚡ auto
          </span>
        )}
        {status === "running" && (
          <span className="board-card__badge board-card__badge--running">running…</span>
        )}
        {status === "answered" && (
          <span className="board-card__badge board-card__badge--answered" title="Agent has answered">
            ✓ answered
          </span>
        )}
        {status === "errored" && (
          <span className="board-card__badge board-card__badge--error">error</span>
        )}
      </div>
    </>
  );
}

/** Non-sortable snapshot of a card, used as the DragOverlay preview. */
export function BoardCardPreview({ card }: { card: BoardCardModel }) {
  const status = cardStatus(card);
  return (
    <div className={`board-card board-card--${status} board-card--preview`}>
      <CardBody card={card} />
    </div>
  );
}

export default function BoardCard({ card, lanes, canEdit, onEdit, onMove, onArchive }: Props) {
  const otherLanes = lanes.filter((l) => l.id !== card.swimlaneId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({
      id: `card-${card.id}`,
      data: { type: "card", cardId: card.id, swimlaneId: card.swimlaneId },
      disabled: !canEdit,
    });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const status = cardStatus(card);
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={
        `board-card board-card--${status}` +
        (isDragging ? " board-card--dragging" : "") +
        (isOver && !isDragging ? " board-card--drop-target" : "")
      }
    >
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
        {card.autoRun && (
          <span className="board-card__badge board-card__badge--auto" title="Auto-run pending">
            ⚡ auto
          </span>
        )}
        {status === "running" && (
          <span className="board-card__badge board-card__badge--running">running…</span>
        )}
        {status === "answered" && (
          <span className="board-card__badge board-card__badge--answered" title="Agent has answered">
            ✓ answered
          </span>
        )}
        {status === "errored" && (
          <span className="board-card__badge board-card__badge--error">error</span>
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
