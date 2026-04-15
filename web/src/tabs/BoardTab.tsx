import { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import {
  archiveCard,
  createCard,
  createSwimlane,
  deleteSwimlane,
  fetchBoard,
  fetchProject,
  fetchProjectAgents,
  moveCard,
  patchCard,
  patchSwimlane,
  type Agent,
  type AuthUser,
  type BoardCard as BoardCardModel,
  type BoardSnapshot,
  type Project,
  type Swimlane,
} from "../api";
import BoardColumn from "../components/BoardColumn";
import { BoardCardPreview } from "../components/BoardCard";
import CardDialog, { type CardDialogValue } from "../components/CardDialog";

interface Props {
  project: string;
  currentUser: AuthUser;
  /** Switch to the Chat tab on the given session id. */
  onOpenInChat: (sessionId: string) => void;
}

type CardDialogState =
  | { kind: "closed" }
  | { kind: "create"; swimlaneId: number }
  | { kind: "edit"; card: BoardCardModel };

export default function BoardTab({ project, currentUser, onOpenInChat }: Props) {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [projectMeta, setProjectMeta] = useState<Project | null>(null);
  const [projectAgents, setProjectAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<CardDialogState>({ kind: "closed" });
  const [dragging, setDragging] = useState<
    | { kind: "card"; card: BoardCardModel }
    | { kind: "lane"; lane: Swimlane }
    | null
  >(null);

  const refresh = useCallback(async () => {
    try {
      const [b, p, a] = await Promise.all([
        fetchBoard(project),
        fetchProject(project),
        fetchProjectAgents(project).catch(() => []),
      ]);
      setBoard(b);
      setProjectMeta(p);
      setProjectAgents(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManageLane =
    !!projectMeta &&
    (currentUser.role === "admin" || projectMeta.createdBy === currentUser.id);

  const canEditCard = (c: BoardCardModel): boolean => {
    if (!projectMeta) return false;
    if (currentUser.role === "admin") return true;
    if (projectMeta.createdBy === currentUser.id) return true;
    if (c.createdBy === currentUser.id) return true;
    if (c.assigneeUserId && c.assigneeUserId === currentUser.id) return true;
    return false;
  };

  const handleAddLane = async () => {
    const name = window.prompt("Name for new swimlane?");
    if (!name?.trim()) return;
    try {
      await createSwimlane(project, { name: name.trim() });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleEditLane = async (lane: Swimlane) => {
    const name = window.prompt("Rename lane:", lane.name);
    if (!name?.trim() || name.trim() === lane.name) return;
    try {
      await patchSwimlane(lane.id, { name: name.trim() });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleLaneAutoRun = async (lane: Swimlane) => {
    try {
      await patchSwimlane(lane.id, { autoRun: !lane.autoRun });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteLane = async (lane: Swimlane) => {
    if (!confirm(`Delete swimlane '${lane.name}'?`)) return;
    try {
      await deleteSwimlane(lane.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmitCard = async (v: CardDialogValue) => {
    if (dialog.kind === "create") {
      await createCard(project, {
        swimlaneId: v.swimlaneId,
        title: v.title,
        description: v.description,
        assigneeUserId: v.assigneeUserId,
        assigneeAgent: v.assigneeAgent,
        autoRun: v.autoRun,
      });
    } else if (dialog.kind === "edit") {
      await patchCard(dialog.card.id, {
        swimlaneId: v.swimlaneId,
        title: v.title,
        description: v.description,
        assigneeUserId: v.assigneeUserId,
        assigneeAgent: v.assigneeAgent,
        autoRun: v.autoRun,
      });
    }
    await refresh();
  };

  const handleMoveCard = async (cardId: number, toLaneId: number) => {
    try {
      await moveCard(cardId, { swimlaneId: toLaneId });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Drag-and-drop ─────────────────────────────────────────
  // Activate after 5px of pointer movement so plain clicks on buttons inside
  // a card still register as clicks rather than drags.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = (event: DragStartEvent) => {
    if (!board) return;
    const id = String(event.active.id);
    if (id.startsWith("card-")) {
      const card = board.cards.find((c) => c.id === Number(id.slice(5)));
      if (card) setDragging({ kind: "card", card });
    } else if (id.startsWith("lane-")) {
      const lane = board.swimlanes.find((l) => l.id === Number(id.slice(5)));
      if (lane) setDragging({ kind: "lane", lane });
    }
  };

  const handleDragCancel = () => setDragging(null);

  const handleDragEnd = async (event: DragEndEvent) => {
    setDragging(null);
    if (!board) return;
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    if (activeId.startsWith("lane-")) {
      if (!overId.startsWith("lane-") || activeId === overId) return;
      const laneId = Number(activeId.slice("lane-".length));
      const overLaneId = Number(overId.slice("lane-".length));
      const lanes = [...board.swimlanes].sort((a, b) => a.position - b.position);
      const fromIdx = lanes.findIndex((l) => l.id === laneId);
      const toIdx = lanes.findIndex((l) => l.id === overLaneId);
      if (fromIdx === -1 || toIdx === -1) return;
      const reordered = [...lanes];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved!);
      const prev = reordered[toIdx - 1];
      const next = reordered[toIdx + 1];
      let newPos: number;
      if (!prev) newPos = (next!.position || 100) - 100;
      else if (!next) newPos = prev.position + 100;
      else newPos = Math.floor((prev.position + next.position) / 2);
      if (prev && next && newPos === prev.position) {
        // Positions collided — re-space all lanes by issuing a full pass.
        // Simpler: bail out and refresh; user can retry. Rare with step=100.
        await refresh();
        return;
      }
      const snapshot = board;
      setBoard({
        ...board,
        swimlanes: reordered.map((l) => (l.id === laneId ? { ...l, position: newPos } : l)),
      });
      try {
        await patchSwimlane(laneId, { position: newPos });
        await refresh();
      } catch (e) {
        setBoard(snapshot);
        alert(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (!activeId.startsWith("card-")) return;
    const cardId = Number(activeId.slice("card-".length));
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;

    let targetLaneId: number;
    let beforeCardId: number | undefined;
    let afterCardId: number | undefined;

    if (overId.startsWith("lane-")) {
      // Dropped on empty lane → append at end.
      targetLaneId = Number(overId.slice("lane-".length));
      const laneCards = board.cards
        .filter((c) => c.swimlaneId === targetLaneId && c.id !== cardId)
        .sort((a, b) => a.position - b.position);
      const last = laneCards.at(-1);
      if (last) afterCardId = last.id;
    } else if (overId.startsWith("card-")) {
      // Dropped on another card → place before it.
      const overCardId = Number(overId.slice("card-".length));
      const overCard = board.cards.find((c) => c.id === overCardId);
      if (!overCard) return;
      targetLaneId = overCard.swimlaneId;
      const laneCards = board.cards
        .filter((c) => c.swimlaneId === targetLaneId && c.id !== cardId)
        .sort((a, b) => a.position - b.position);
      const overIdx = laneCards.findIndex((c) => c.id === overCardId);
      if (overIdx === -1) return;
      const prev = laneCards[overIdx - 1];
      if (prev) beforeCardId = prev.id;
      afterCardId = overCardId;
    } else {
      return;
    }

    if (
      targetLaneId === card.swimlaneId &&
      beforeCardId === undefined &&
      afterCardId === undefined
    ) {
      return;
    }

    // Optimistic update.
    const snapshot = board;
    const optimistic: BoardSnapshot = {
      ...board,
      cards: board.cards.map((c) =>
        c.id === cardId ? { ...c, swimlaneId: targetLaneId } : c,
      ),
    };
    setBoard(optimistic);

    try {
      await moveCard(cardId, { swimlaneId: targetLaneId, beforeCardId, afterCardId });
      // Re-fetch to get authoritative positions.
      await refresh();
    } catch (e) {
      setBoard(snapshot);
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleArchiveCard = async (cardId: number) => {
    if (!confirm("Archive this card?")) return;
    try {
      await archiveCard(cardId);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  if (!board) {
    return (
      <div className="board">
        {error && <div className="board__error">{error}</div>}
        {!error && <div className="board__loading">Loading board…</div>}
      </div>
    );
  }

  return (
    <div className="board">
      <header className="board__header">
        <h1>Board · {project}</h1>
        {canManageLane && (
          <button className="board__add-lane" onClick={handleAddLane}>
            + swimlane
          </button>
        )}
      </header>

      {error && <div className="board__error">{error}</div>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
      <SortableContext
        items={board.swimlanes.map((l) => `lane-${l.id}`)}
        strategy={horizontalListSortingStrategy}
      >
      <div className="board__columns">
        {board.swimlanes.map((lane) => (
          <BoardColumn
            key={lane.id}
            lane={lane}
            cards={board.cards.filter((c) => c.swimlaneId === lane.id)}
            allLanes={board.swimlanes}
            canManageLane={canManageLane}
            canEditCard={canEditCard}
            onAddCard={() => setDialog({ kind: "create", swimlaneId: lane.id })}
            onEditLane={() => handleEditLane(lane)}
            onToggleAutoRun={() => handleToggleLaneAutoRun(lane)}
            onDeleteLane={() => handleDeleteLane(lane)}
            onEditCard={(c) => setDialog({ kind: "edit", card: c })}
            onMoveCard={handleMoveCard}
            onArchiveCard={handleArchiveCard}
          />
        ))}
      </div>
      </SortableContext>
      <DragOverlay
        dropAnimation={{
          duration: 180,
          easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
          sideEffects: defaultDropAnimationSideEffects({
            styles: { active: { opacity: "0.4" } },
          }),
        }}
      >
        {dragging?.kind === "card" && (
          <div className="board-card-overlay">
            <BoardCardPreview card={dragging.card} />
          </div>
        )}
        {dragging?.kind === "lane" && (
          <div className="board-column-overlay">
            <div className="board-column-overlay__title">{dragging.lane.name}</div>
          </div>
        )}
      </DragOverlay>
      </DndContext>

      {dialog.kind !== "closed" && (
        <CardDialog
          mode={dialog.kind === "create" ? "create" : "edit"}
          swimlanes={board.swimlanes}
          agents={projectAgents}
          initial={dialog.kind === "edit" ? dialog.card : undefined}
          defaultSwimlaneId={dialog.kind === "create" ? dialog.swimlaneId : undefined}
          currentUser={currentUser}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleSubmitCard}
          onOpenSession={onOpenInChat}
        />
      )}
    </div>
  );
}
