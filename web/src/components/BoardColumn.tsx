import type { CSSProperties } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  onToggleAutoRun: () => void;
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
  onToggleAutoRun,
  onDeleteLane,
  onEditCard,
  onMoveCard,
  onArchiveCard,
}: Props) {
  const {
    setNodeRef,
    isOver,
    transform,
    transition,
    isDragging,
    attributes,
    listeners,
  } = useSortable({
    id: `lane-${lane.id}`,
    data: { type: "lane", swimlaneId: lane.id },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`board-column ${isOver ? "board-column--over" : ""} ${lane.autoRun ? "board-column--auto" : ""}`}
    >
      <header className="board-column__header">
        <div className="board-column__title">
          {canManageLane && (
            <button
              className="board-column__handle"
              title="Drag to reorder lane"
              aria-label="Drag to reorder lane"
              {...attributes}
              {...listeners}
            >
              ⋮⋮
            </button>
          )}
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
            <button
              onClick={onToggleAutoRun}
              title={lane.autoRun ? "Disable auto-run" : "Enable auto-run"}
              aria-label="Toggle auto-run"
            >
              {lane.autoRun ? "⚡" : "⌁"}
            </button>
            <button onClick={onEditLane} title="Edit lane">
              ✎
            </button>
            <button onClick={onDeleteLane} title="Delete lane" disabled={cards.length > 0}>
              ✕
            </button>
          </div>
        )}
      </header>

      <SortableContext
        items={cards.map((c) => `card-${c.id}`)}
        strategy={verticalListSortingStrategy}
      >
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
      </SortableContext>

      <button className="board-column__add" onClick={onAddCard}>
        + new card
      </button>
    </div>
  );
}
