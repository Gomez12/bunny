import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectUiPrefs } from "../hooks/useProjectUiPrefs";
import EmptyState from "../components/EmptyState";
import DiagramCanvas, { type DiagramCanvasRef, type DiagramContent } from "./diagrams/DiagramCanvas";
import DiagramNodeLibrary from "./diagrams/DiagramNodeLibrary";
import DiagramComposer from "./diagrams/DiagramComposer";
import DiagramNewDialog from "./diagrams/DiagramNewDialog";
import {
  fetchDiagrams,
  fetchDiagram,
  createDiagram,
  patchDiagram,
  deleteDiagram,
  generateDiagram,
  editDiagram,
  askDiagram,
  fetchDiagramLibrary,
  deleteDiagramLibraryItem,
  generateDiagramLibraryItem,
  type DiagramSummary,
  type DiagramFull,
  type DiagramLibraryItem,
  type AuthUser,
  type OpenInChatFn,
  type ServerEvent,
} from "../api";
import { Plus, Pencil, Trash2, ChevronLeft, Loader2, Shapes } from "../lib/icons";
import HistoryButton from "../components/HistoryButton";
import { DIAGRAM_TYPE_LABELS } from "./diagrams/constants";

const AUTOSAVE_MS = 5_000;

interface Props {
  project: string;
  currentUser: AuthUser;
  onOpenInChat: OpenInChatFn;
}

function emptyContent(): DiagramContent {
  return { nodes: [], edges: [] };
}

export default function DiagramsTab({ project, currentUser, onOpenInChat }: Props) {
  const { prefs, setPref } = useProjectUiPrefs(project);
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [activeDiagram, setActiveDiagram] = useState<DiagramFull | null>(null);
  const [libraryItems, setLibraryItems] = useState<DiagramLibraryItem[]>([]);
  const [content, setContent] = useState<DiagramContent>(emptyContent());
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<"edit" | "question">("edit");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const canvasRef = useRef<DiagramCanvasRef | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const onChangeRef = useRef<((c: DiagramContent) => void) | null>(null);

  const reload = useCallback(async () => {
    const list = await fetchDiagrams(project);
    setDiagrams(list);
    return list;
  }, [project]);

  const reloadLibrary = useCallback(async () => {
    const items = await fetchDiagramLibrary(project);
    setLibraryItems(items);
  }, [project]);

  useEffect(() => {
    void reload();
    void reloadLibrary();
  }, [project, reload, reloadLibrary]);

  useEffect(() => {
    onChangeRef.current = (c: DiagramContent) => {
      const serialized = JSON.stringify(c);
      if (serialized === lastSavedRef.current) return;
      setDirty(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => void autoSave(c), AUTOSAVE_MS);
    };
    return () => {
      onChangeRef.current = null;
    };
  });

  const autoSave = async (c: DiagramContent) => {
    if (!activeDiagram) return;
    const serialized = JSON.stringify(c);
    if (serialized === lastSavedRef.current) return;
    try {
      await patchDiagram(activeDiagram.id, { contentJson: serialized });
      lastSavedRef.current = serialized;
      setDirty(false);
    } catch {}
  };

  const handleSave = async () => {
    if (!activeDiagram || !canvasRef.current) return;
    const c = canvasRef.current.getContent();
    const serialized = JSON.stringify(c);
    const thumb = canvasRef.current.captureThumb();
    await patchDiagram(activeDiagram.id, { contentJson: serialized, thumbnail: thumb });
    lastSavedRef.current = serialized;
    setDirty(false);
    setDiagrams((prev) =>
      prev.map((d) => (d.id === activeDiagram.id ? { ...d, thumbnail: thumb, updatedAt: Date.now() } : d)),
    );
  };

  const handleSelect = async (id: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setError(null);
    try {
      const diag = await fetchDiagram(id);
      let parsed: DiagramContent;
      try {
        parsed = JSON.parse(diag.contentJson) as DiagramContent;
        if (!Array.isArray(parsed.nodes)) parsed = emptyContent();
      } catch {
        parsed = emptyContent();
      }
      setContent(parsed);
      lastSavedRef.current = JSON.stringify(parsed);
      setActiveDiagram(diag);
      setDirty(false);
      const stored = localStorage.getItem(`bunny.activeDiagram.${project}`);
      if (String(id) !== stored) localStorage.setItem(`bunny.activeDiagram.${project}`, String(id));
      setPref("activeDiagramId", id);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreate = async (name: string, diagramType: string, intent: string) => {
    setCreating(true);
    setShowNewDialog(false);
    try {
      const diag = await createDiagram(project, { name, diagramType });
      await reload();

      if (intent) {
        setGenerating(true);
        await handleSelect(diag.id);
        const library = await fetchDiagramLibrary(project, diagramType);
        try {
          const res = await generateDiagram(diag.id, { intent });
          if (res.ok && res.body) {
            const parsed = await streamToContent(res);
            if (parsed) {
              canvasRef.current?.setContent(parsed);
              setContent(parsed);
              const serialized = JSON.stringify(parsed);
              await patchDiagram(diag.id, { contentJson: serialized });
              lastSavedRef.current = serialized;
              setDirty(false);
            }
          }
        } finally {
          setGenerating(false);
          setLibraryItems(library);
        }
      } else {
        await handleSelect(diag.id);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const streamToContent = async (res: Response): Promise<DiagramContent | null> => {
    if (!res.body) return null;
    let accumulated = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const ev = JSON.parse(raw) as ServerEvent;
          if (ev.type === "content") accumulated += ev.text ?? "";
        } catch {}
      }
    }
    const match = accumulated.match(/```json\s*([\s\S]*?)```/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]!) as DiagramContent;
      if (!Array.isArray(parsed.nodes)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const handleSend = async (prompt: string) => {
    if (!activeDiagram || streaming) return;
    const currentContent = canvasRef.current?.getContent() ?? content;

    if (mode === "question") {
      try {
        const res = await askDiagram(activeDiagram.id, {
          prompt,
          contentJson: JSON.stringify(currentContent),
        });
        onOpenInChat(res.sessionId, { prompt: res.prompt, isQuickChat: res.isQuickChat });
      } catch (e) {
        setError(String(e));
      }
      return;
    }

    setStreaming(true);
    setError(null);
    try {
      const res = await editDiagram(activeDiagram.id, {
        prompt,
        contentJson: JSON.stringify(currentContent),
      });
      if (!res.ok || !res.body) {
        setError("Edit failed");
        return;
      }
      const parsed = await streamToContent(res);
      if (parsed) {
        canvasRef.current?.setContent(parsed);
        setContent(parsed);
        const serialized = JSON.stringify(parsed);
        await patchDiagram(activeDiagram.id, { contentJson: serialized });
        lastSavedRef.current = serialized;
        setDirty(false);
      } else {
        setError("No diagram data returned");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Move this diagram to trash?")) return;
    await deleteDiagram(id);
    if (activeDiagram?.id === id) setActiveDiagram(null);
    void reload();
  };

  const handleRename = async () => {
    if (!activeDiagram || !renameValue.trim()) { setRenaming(false); return; }
    try {
      const updated = await patchDiagram(activeDiagram.id, { name: renameValue.trim() });
      setActiveDiagram((prev) => prev ? { ...prev, name: updated.name } : prev);
      setDiagrams((prev) => prev.map((d) => d.id === updated.id ? { ...d, name: updated.name } : d));
    } catch (e) {
      setError(String(e));
    }
    setRenaming(false);
  };

  const handleDeleteLibraryItem = async (id: number) => {
    await deleteDiagramLibraryItem(id);
    setLibraryItems((prev) => prev.filter((it) => it.id !== id));
  };

  const handleItemGenerated = (item: DiagramLibraryItem) => {
    setLibraryItems((prev) => [...prev, item]);
  };

  // Restore last active diagram on mount — prefer server pref, fall back to localStorage.
  useEffect(() => {
    const serverId = prefs.activeDiagramId;
    if (serverId) {
      void handleSelect(serverId);
      return;
    }
    const stored = localStorage.getItem(`bunny.activeDiagram.${project}`);
    if (stored) {
      const id = Number(stored);
      if (!isNaN(id)) void handleSelect(id);
    }
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeDiagram) {
    return (
      <div className="diagrams-tab">
        <div className="diagrams-tab__gallery-header">
          <span className="diagrams-tab__gallery-title">Diagrams</span>
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => setShowNewDialog(true)}
            disabled={creating}
          >
            <Plus size={14} /> New diagram
          </button>
        </div>

        {diagrams.length === 0 ? (
          <EmptyState
            title="No diagrams yet"
            description="Create a Visio-like diagram and edit it with AI."
            action={
              <button
                type="button"
                className="btn btn--accent"
                onClick={() => setShowNewDialog(true)}
                disabled={creating}
              >
                <Plus size={14} /> New diagram
              </button>
            }
          />
        ) : (
          <div className="diagrams-gallery">
            {diagrams.map((d) => (
              <button
                key={d.id}
                type="button"
                className="diagram-card"
                onClick={() => void handleSelect(d.id)}
              >
                <div className="diagram-card__thumb">
                  {d.thumbnail ? (
                    <img src={d.thumbnail} alt={d.name} />
                  ) : (
                    <Shapes size={32} strokeWidth={1} />
                  )}
                </div>
                <div className="diagram-card__info">
                  <span className="diagram-card__name">{d.name}</span>
                  <span className="diagram-card__type">
                    {DIAGRAM_TYPE_LABELS[d.diagramType] ?? d.diagramType}
                  </span>
                </div>
                <span
                  className="diagram-card__actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <HistoryButton
                    kind="diagram"
                    entityId={d.id}
                    entityName={d.name}
                  />
                  <button
                    type="button"
                    className="diagram-card__del"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(d.id); }}
                    title="Delete"
                    aria-label={`Delete ${d.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </button>
            ))}
          </div>
        )}

        {showNewDialog && (
          <DiagramNewDialog
            onClose={() => setShowNewDialog(false)}
            onCreate={handleCreate}
            busy={creating}
          />
        )}
        {error && <div className="diagrams-tab__error">{error}</div>}
      </div>
    );
  }

  const canEdit = currentUser.role === "admin" || activeDiagram.createdBy === currentUser.id;

  return (
    <div className="diagrams-tab diagrams-tab--editor">
      <div className="diagrams-tab__toolbar">
        <button
          type="button"
          className="btn diagrams-tab__back"
          onClick={() => { setActiveDiagram(null); setContent(emptyContent()); }}
          title="Back to gallery"
        >
          <ChevronLeft size={16} />
        </button>
        {renaming ? (
          <input
            className="diagrams-tab__rename-input"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => void handleRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="diagrams-tab__name" title={activeDiagram.name}>
            {activeDiagram.name}
          </span>
        )}
        <span className="diagrams-tab__type-badge">
          {DIAGRAM_TYPE_LABELS[activeDiagram.diagramType] ?? activeDiagram.diagramType}
        </span>
        {dirty && <span className="diagrams-tab__unsaved">Unsaved</span>}
        {(generating || streaming) && <Loader2 size={14} className="spinner" />}
        <div className="diagrams-tab__toolbar-actions">
          {canEdit && (
            <button
              type="button"
              className="btn"
              title="Rename"
              onClick={() => { setRenameValue(activeDiagram.name); setRenaming(true); }}
            >
              <Pencil size={14} />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn"
              title="Delete diagram"
              onClick={() => void handleDelete(activeDiagram.id)}
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => setShowNewDialog(true)}
            title="New diagram"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="diagrams-tab__body">
        <DiagramNodeLibrary
          items={libraryItems}
          activeDiagramType={activeDiagram.diagramType}
          project={project}
          canEdit={canEdit}
          onDeleteItem={(id) => void handleDeleteLibraryItem(id)}
          onItemGenerated={handleItemGenerated}
          generateFn={generateDiagramLibraryItem}
        />

        <div className="diagrams-tab__canvas-col">
          <div className="diagrams-tab__canvas-wrap">
            <DiagramCanvas
              initialContent={content}
              readOnly={!canEdit || streaming || generating}
              onChangeRef={onChangeRef}
              innerRef={canvasRef}
            />
            {(streaming || generating) && (
              <div className="diagrams-tab__overlay">
                <span className="spinner" />
                <span>
                  {generating ? "AI is generating the diagram…" : "AI is editing the diagram…"}
                </span>
              </div>
            )}
          </div>

          <DiagramComposer
            mode={mode}
            onModeChange={setMode}
            onSend={(p) => void handleSend(p)}
            streaming={streaming}
            dirty={dirty}
            onSave={canEdit ? () => void handleSave() : undefined}
          />
        </div>
      </div>

      {showNewDialog && (
        <DiagramNewDialog
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreate}
          busy={creating}
        />
      )}
      {error && <div className="diagrams-tab__error">{error}</div>}
    </div>
  );
}
