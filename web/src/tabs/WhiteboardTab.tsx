import { useCallback, useEffect, useRef, useState } from "react";
import WhiteboardSidebar from "../components/WhiteboardSidebar";
import WhiteboardComposer from "../components/WhiteboardComposer";
import WhiteboardCanvas, {
  exportCanvasPng,
  exportThumbnail,
  restoreElements,
  type ExcalidrawImperativeAPI,
  type ExcalidrawElement,
} from "../components/WhiteboardCanvas";
import {
  fetchWhiteboards,
  fetchWhiteboard,
  createWhiteboard,
  patchWhiteboard,
  deleteWhiteboard,
  editWhiteboard,
  askWhiteboard,
  fetchUiConfig,
  type WhiteboardSummary,
  type ServerEvent,
} from "../api";

interface Props {
  project: string;
  onOpenInChat: (sessionId: string) => void;
}

export default function WhiteboardTab({ project, onOpenInChat }: Props) {
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [initialElements, setInitialElements] = useState<readonly ExcalidrawElement[] | undefined>(
    undefined,
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mode, setMode] = useState<"edit" | "question">("edit");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const [dirty, setDirty] = useState(false);
  const autosaveMs = useRef(5_000);

  const reload = useCallback(async () => {
    const list = await fetchWhiteboards(project);
    setWhiteboards(list);
    return list;
  }, [project]);

  useEffect(() => {
    void fetchUiConfig()
      .then((cfg) => { autosaveMs.current = cfg.autosaveIntervalMs; })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void reload().then((list) => {
      if (list.length > 0 && activeId === null) {
        handleSelect(list[0]!.id);
      }
    });
  }, [project]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeId]);

  const handleSelect = async (id: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setActiveId(id);
    setError(null);
    try {
      const wb = await fetchWhiteboard(id);
      const raw = JSON.parse(wb.elementsJson);
      const elements = restoreElements(Array.isArray(raw) ? raw : [], null);
      setInitialElements(elements);
      lastSavedRef.current = JSON.stringify(elements);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreate = async (name: string) => {
    try {
      const wb = await createWhiteboard(project, name);
      await reload();
      handleSelect(wb.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteWhiteboard(id);
      const list = await reload();
      if (activeId === id) {
        if (list.length > 0) {
          handleSelect(list[0]!.id);
        } else {
          setActiveId(null);
          setInitialElements(undefined);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRename = async (id: number, name: string) => {
    try {
      await patchWhiteboard(id, { name });
      setWhiteboards((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)));
    } catch (e) {
      setError(String(e));
    }
  };

  const saveNow = useCallback(async () => {
    if (!apiRef.current || activeId === null) return;
    const elements = apiRef.current.getSceneElements();
    const elementsJson = JSON.stringify(elements);
    if (elementsJson === lastSavedRef.current) return;
    lastSavedRef.current = elementsJson;
    try {
      const thumb = await exportThumbnail(apiRef.current);
      await patchWhiteboard(activeId, { elementsJson, thumbnail: thumb || null });
      setWhiteboards((prev) =>
        prev.map((w) => (w.id === activeId ? { ...w, thumbnail: thumb || null, updatedAt: Date.now() } : w)),
      );
    } catch {
      // silent — will retry on next change
    }
  }, [activeId]);

  const handleChange = useCallback(() => {
    setDirty(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveNow().then(() => setDirty(false));
    }, autosaveMs.current);
  }, [saveNow]);

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  const handleManualSave = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await saveNow();
    setDirty(false);
  }, [saveNow]);

  const extractJson = (text: string): string | null => {
    const fenceMatch = text.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) return fenceMatch[1]!;
    const trimmed = text.trim();
    if (trimmed.startsWith("[")) return trimmed;
    return null;
  };

  const handleSend = async (prompt: string) => {
    if (!apiRef.current || activeId === null) return;

    setError(null);

    if (mode === "question") {
      setStreaming(true);
      try {
        await saveNow();
        const screenshotDataUrl = await exportCanvasPng(apiRef.current);
        const elements = apiRef.current.getSceneElements();
        const { sessionId } = await askWhiteboard(activeId, {
          prompt,
          elementsJson: JSON.stringify(elements),
          screenshotDataUrl,
          thumbnail: await exportThumbnail(apiRef.current),
        });
        onOpenInChat(sessionId);
      } catch (e) {
        setError(String(e));
      } finally {
        setStreaming(false);
      }
      return;
    }

    setStreaming(true);
    try {
      const elements = apiRef.current.getSceneElements();
      const elementsJson = JSON.stringify(elements);
      let screenshotDataUrl: string | undefined;
      try {
        screenshotDataUrl = await exportCanvasPng(apiRef.current);
      } catch {
        // canvas might be empty
      }

      const res = await editWhiteboard(activeId, {
        prompt,
        elementsJson,
        screenshotDataUrl,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        setError(err.error ?? `HTTP ${res.status}`);
        setStreaming(false);
        return;
      }

      let fullContent = "";
      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response body");
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;
          try {
            const ev = JSON.parse(raw) as ServerEvent;
            if (ev.type === "content") fullContent += ev.text;
            if (ev.type === "error") setError(ev.message);
          } catch {
            // ignore parse errors
          }
        }
      }

      const jsonStr = extractJson(fullContent);
      if (!jsonStr) {
        setError("Could not extract valid JSON from the response");
        setStreaming(false);
        return;
      }

      try {
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) throw new Error("expected array");
        const restored = restoreElements(parsed, null);
        apiRef.current.updateScene({ elements: restored });
        const restoredJson = JSON.stringify(restored);
        lastSavedRef.current = restoredJson;
        const thumb = await exportThumbnail(apiRef.current);
        await patchWhiteboard(activeId, {
          elementsJson: restoredJson,
          thumbnail: thumb || null,
        });
        setWhiteboards((prev) =>
          prev.map((w) => (w.id === activeId ? { ...w, thumbnail: thumb || null, updatedAt: Date.now() } : w)),
        );
      } catch (e) {
        setError(`Invalid elements JSON: ${e}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="wb-tab">
      <WhiteboardSidebar
        whiteboards={whiteboards}
        activeId={activeId}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
      />
      <div className="wb-tab__main">
        {activeId !== null ? (
          <>
            <WhiteboardCanvas
              initialElements={initialElements}
              isFullscreen={isFullscreen}
              onApiReady={handleApiReady}
              onChange={handleChange}
              onToggleFullscreen={() => setIsFullscreen((f) => !f)}
            />
            {streaming && (
              <div className="wb-tab__overlay">
                <span className="spinner" />
                <span>AI is editing the whiteboard…</span>
              </div>
            )}
            {error && (
              <div className="wb-tab__error">
                {error}
                <button className="wb-tab__error-close" onClick={() => setError(null)}>
                  &times;
                </button>
              </div>
            )}
            <WhiteboardComposer
              mode={mode}
              onModeChange={setMode}
              onSend={handleSend}
              onSave={handleManualSave}
              streaming={streaming}
              dirty={dirty}
            />
          </>
        ) : (
          <div className="wb-tab__empty">
            <h2>No whiteboards yet</h2>
            <p>Create one to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
