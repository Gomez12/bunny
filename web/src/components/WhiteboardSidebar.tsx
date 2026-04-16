import { useState, useRef, useEffect } from "react";
import type { WhiteboardSummary } from "../api";

interface Props {
  whiteboards: WhiteboardSummary[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, name: string) => void;
}

export default function WhiteboardSidebar({
  whiteboards,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  useEffect(() => {
    if (editingId !== null && editRef.current) editRef.current.focus();
  }, [editingId]);

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setNewName("");
    setCreating(false);
  };

  const handleRename = (id: number) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    onRename(id, trimmed);
    setEditingId(null);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <div className="sidebar">
      <button
        className="btn btn--accent sidebar__new"
        onClick={() => setCreating(true)}
      >
        + New whiteboard
      </button>

      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          style={{ padding: "0 4px" }}
        >
          <input
            ref={inputRef}
            className="sidebar__search"
            placeholder="Whiteboard name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => {
              if (!newName.trim()) setCreating(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreating(false);
            }}
          />
        </form>
      )}

      <ul className="sidebar__list">
        {whiteboards.map((wb) => (
          <li key={wb.id} className="sidebar__row">
            <button
              className={`sidebar__item${wb.id === activeId ? " sidebar__item--active" : ""}`}
              onClick={() => onSelect(wb.id)}
            >
              {wb.thumbnail && (
                <img
                  src={wb.thumbnail}
                  alt=""
                  className="wb-sidebar__thumb"
                />
              )}
              {editingId === wb.id ? (
                <input
                  ref={editRef}
                  className="sidebar__search"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRename(wb.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(wb.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div className="sidebar__item-title">{wb.name}</div>
                  <div className="sidebar__item-meta">{formatDate(wb.updatedAt)}</div>
                </>
              )}
            </button>
            <button
              className="sidebar__hide-btn"
              title="Rename"
              onClick={() => {
                setEditingId(wb.id);
                setEditName(wb.name);
              }}
            >
              &#9998;
            </button>
            <button
              className="sidebar__hide-btn"
              title="Delete"
              onClick={() => {
                if (confirm(`Delete whiteboard "${wb.name}"?`)) onDelete(wb.id);
              }}
            >
              &times;
            </button>
          </li>
        ))}
        {whiteboards.length === 0 && !creating && (
          <li className="sidebar__empty">No whiteboards yet</li>
        )}
      </ul>
    </div>
  );
}
