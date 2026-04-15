import { useCallback, useEffect, useState } from "react";
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
import CardDialog, { type CardDialogValue } from "../components/CardDialog";

interface Props {
  project: string;
  currentUser: AuthUser;
}

type CardDialogState =
  | { kind: "closed" }
  | { kind: "create"; swimlaneId: number }
  | { kind: "edit"; card: BoardCardModel };

export default function BoardTab({ project, currentUser }: Props) {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [projectMeta, setProjectMeta] = useState<Project | null>(null);
  const [projectAgents, setProjectAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<CardDialogState>({ kind: "closed" });

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
      });
    } else if (dialog.kind === "edit") {
      await patchCard(dialog.card.id, {
        swimlaneId: v.swimlaneId,
        title: v.title,
        description: v.description,
        assigneeUserId: v.assigneeUserId,
        assigneeAgent: v.assigneeAgent,
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
            onDeleteLane={() => handleDeleteLane(lane)}
            onEditCard={(c) => setDialog({ kind: "edit", card: c })}
            onMoveCard={handleMoveCard}
            onArchiveCard={handleArchiveCard}
          />
        ))}
      </div>

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
        />
      )}
    </div>
  );
}
