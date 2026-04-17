import { useState, useRef, useEffect } from "react";
import type { DocumentSummary } from "../api";

interface Props {
  documents: DocumentSummary[];
  templates: DocumentSummary[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onCreateFromTemplate: (templateId: number, name: string) => void;
  onDeleteTemplate: (id: number) => void;
  onRenameTemplate: (id: number, name: string) => void;
}

export default function DocumentSidebar({
  documents,
  templates,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onCreateFromTemplate,
  onDeleteTemplate,
  onRenameTemplate,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [promptingTemplateId, setPromptingTemplateId] = useState<number | null>(null);
  const [templateDocName, setTemplateDocName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const templateNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  useEffect(() => {
    if (editingId !== null && editRef.current) editRef.current.focus();
  }, [editingId]);

  useEffect(() => {
    if (promptingTemplateId !== null && templateNameRef.current) templateNameRef.current.focus();
  }, [promptingTemplateId]);

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setNewName("");
    setCreating(false);
  };

  const handleRename = (id: number, isTemplate: boolean) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    if (isTemplate) {
      onRenameTemplate(id, trimmed);
    } else {
      onRename(id, trimmed);
    }
    setEditingId(null);
  };

  const handleTemplateCreate = () => {
    const trimmed = templateDocName.trim();
    if (!trimmed || promptingTemplateId === null) return;
    onCreateFromTemplate(promptingTemplateId, trimmed);
    setTemplateDocName("");
    setPromptingTemplateId(null);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const renderItem = (
    item: DocumentSummary,
    isTemplate: boolean,
  ) => (
    <li key={item.id} className="sidebar__row">
      <button
        className={`sidebar__item${item.id === activeId && !isTemplate ? " sidebar__item--active" : ""}`}
        onClick={() => {
          if (isTemplate) {
            setPromptingTemplateId(item.id);
            setTemplateDocName("");
          } else {
            onSelect(item.id);
          }
        }}
      >
        {editingId === item.id ? (
          <input
            ref={editRef}
            className="sidebar__search"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => handleRename(item.id, isTemplate)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename(item.id, isTemplate);
              if (e.key === "Escape") setEditingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="sidebar__item-title">{item.name}</div>
            <div className="sidebar__item-meta">{formatDate(item.updatedAt)}</div>
          </>
        )}
      </button>
      <button
        className="sidebar__hide-btn"
        title="Rename"
        onClick={() => {
          setEditingId(item.id);
          setEditName(item.name);
        }}
      >
        &#9998;
      </button>
      <button
        className="sidebar__hide-btn"
        title="Delete"
        onClick={() => {
          const label = isTemplate ? "template" : "document";
          if (confirm(`Delete ${label} "${item.name}"?`)) {
            if (isTemplate) onDeleteTemplate(item.id);
            else onDelete(item.id);
          }
        }}
      >
        &times;
      </button>
    </li>
  );

  return (
    <div className="sidebar">
      <button
        className="btn btn--accent sidebar__new"
        onClick={() => setCreating(true)}
      >
        + New document
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
            placeholder="Document name..."
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
        {documents.map((doc) => renderItem(doc, false))}
        {documents.length === 0 && !creating && (
          <li className="sidebar__empty">No documents yet</li>
        )}
      </ul>

      {/* Templates section */}
      <div className="doc-sidebar__section">
        <button
          className="doc-sidebar__section-header"
          onClick={() => setTemplatesOpen((v) => !v)}
        >
          <span className={`doc-sidebar__chevron${templatesOpen ? " doc-sidebar__chevron--open" : ""}`}>
            &#9654;
          </span>
          Templates
          <span className="doc-sidebar__count">{templates.length}</span>
        </button>

        {templatesOpen && (
          <>
            {promptingTemplateId !== null && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleTemplateCreate();
                }}
                style={{ padding: "0 4px" }}
              >
                <input
                  ref={templateNameRef}
                  className="sidebar__search"
                  placeholder="New document name..."
                  value={templateDocName}
                  onChange={(e) => setTemplateDocName(e.target.value)}
                  onBlur={() => {
                    if (!templateDocName.trim()) setPromptingTemplateId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPromptingTemplateId(null);
                  }}
                />
              </form>
            )}
            <ul className="sidebar__list">
              {templates.map((t) => renderItem(t, true))}
              {templates.length === 0 && (
                <li className="sidebar__empty">No templates yet</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
