import type { BoardCard as BoardCardModel, Swimlane } from "../api";
import BoardCard from "./BoardCard";

interface Props {
  lane: Swimlane;
  cards: BoardCardModel[];
  allLanes: Swimlane[];
  canManageLane: boolean;
  canEditCard: (c: BoardCardModel) => boolean;
  onAddCard: () => void;
  onEditLane: () => void;
  onDeleteLane: () => void;
  onEditCard: (c: BoardCardModel) => void;
  onMoveCard: (cardId: number, toLaneId: number) => void;
  onArchiveCard: (cardId: number) => void;
}

export default function BoardColumn({
  lane,
  cards,
  allLanes,
  canManageLane,
  canEditCard,
  onAddCard,
  onEditLane,
  onDeleteLane,
  onEditCard,
  onMoveCard,
  onArchiveCard,
}: Props) {
  return (
    <div className="board-column">
      <header className="board-column__header">
        <div className="board-column__title">
          {lane.name}
          <span className="board-column__count">{cards.length}</span>
          {lane.wipLimit != null && (
            <span
              className={`board-column__wip ${cards.length > lane.wipLimit ? "board-column__wip--over" : ""}`}
            >
              / {lane.wipLimit}
            </span>
          )}
        </div>
        {canManageLane && (
          <div className="board-column__actions">
            <button onClick={onEditLane} title="Edit lane">
              ✎
            </button>
            <button onClick={onDeleteLane} title="Delete lane" disabled={cards.length > 0}>
              ✕
            </button>
          </div>
        )}
      </header>

      <div className="board-column__cards">
        {cards.map((c) => (
          <BoardCard
            key={c.id}
            card={c}
            lanes={allLanes}
            canEdit={canEditCard(c)}
            onEdit={() => onEditCard(c)}
            onMove={(to) => onMoveCard(c.id, to)}
            onArchive={() => onArchiveCard(c.id)}
          />
        ))}
        {cards.length === 0 && <div className="board-column__empty">empty</div>}
      </div>

      <button className="board-column__add" onClick={onAddCard}>
        + new card
      </button>
    </div>
  );
}
