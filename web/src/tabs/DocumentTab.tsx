import { useCallback, useEffect, useRef, useState } from "react";
import DocumentSidebar from "../components/DocumentSidebar";
import DocumentComposer from "../components/DocumentComposer";
import DocumentEditor, { type DocumentEditorHandle } from "../components/DocumentEditor";
import WhiteboardPickerDialog from "../components/WhiteboardPickerDialog";
import LanguageTabs, { translationStatusToPill } from "../components/LanguageTabs";
import StatusPill, { type PillStatus } from "../components/StatusPill";
import MarkdownContent from "../components/MarkdownContent";
import { useTranslations } from "../hooks/useTranslations";
import {
  fetchDocuments,
  fetchDocument,
  createDocument,
  patchDocument,
  deleteDocument,
  editDocument,
  askDocument,
  exportDocument,
  saveAsTemplate,
  fetchUiConfig,
  type AuthUser,
  type DocumentSummary,
  type ServerEvent,
} from "../api";

interface Props {
  project: string;
  currentUser: AuthUser;
  onOpenInChat: import("../api").OpenInChatFn;
}

export default function DocumentTab({ project, currentUser, onOpenInChat }: Props) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [templates, setTemplates] = useState<DocumentSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeOriginalLang, setActiveOriginalLang] = useState<string | null>(
    null,
  );
  const [contentMd, setContentMd] = useState("");
  const [mode, setMode] = useState<"edit" | "question">("edit");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWbPicker, setShowWbPicker] = useState(false);

  const editorRef = useRef<DocumentEditorHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const [dirty, setDirty] = useState(false);
  const autosaveMs = useRef(5_000);
  const contentRef = useRef(contentMd);
  contentRef.current = contentMd;

  const reload = useCallback(async () => {
    const [list, tpls] = await Promise.all([
      fetchDocuments(project),
      fetchDocuments(project, { template: true }),
    ]);
    setDocuments(list);
    setTemplates(tpls);
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
    setError(null);
    try {
      const doc = await fetchDocument(id);
      setContentMd(doc.contentMd);
      lastSavedRef.current = doc.contentMd;
      setActiveId(id);
      setActiveOriginalLang(doc.originalLang);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreate = async (name: string) => {
    try {
      const doc = await createDocument(project, name);
      await reload();
      handleSelect(doc.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteDocument(id);
      const list = await reload();
      if (activeId === id) {
        if (list.length > 0) {
          handleSelect(list[0]!.id);
        } else {
          setActiveId(null);
          setContentMd("");
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRename = async (id: number, name: string) => {
    try {
      await patchDocument(id, { name });
      setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)));
    } catch (e) {
      setError(String(e));
    }
  };

  const doSave = useCallback(async (md: string, docId: number) => {
    if (md === lastSavedRef.current) return;
    lastSavedRef.current = md;
    try {
      await patchDocument(docId, { contentMd: md });
      setDocuments((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, updatedAt: Date.now() } : d)),
      );
    } catch {
      // silent retry on next change
    }
  }, []);

  const handleContentChange = useCallback((md: string) => {
    setContentMd(md);
    setDirty(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const currentMd = contentRef.current;
      void doSave(currentMd, activeId!).then(() => setDirty(false));
    }, autosaveMs.current);
  }, [doSave, activeId]);

  const handleManualSave = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    await doSave(contentRef.current, activeId!);
    setDirty(false);
  }, [doSave, activeId]);

  const handleExport = useCallback(async (format: "docx" | "html" | "pdf") => {
    if (activeId === null) return;
    if (format === "pdf") {
      window.print();
      return;
    }
    try {
      if (dirty) await doSave(contentRef.current, activeId);
      const blob = await exportDocument(activeId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const docName = documents.find((d) => d.id === activeId)?.name ?? "document";
      a.download = `${docName}.${format === "docx" ? "docx" : "zip"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e));
    }
  }, [activeId, dirty, doSave, documents]);

  const handleSaveAsTemplate = useCallback(async () => {
    if (activeId === null) return;
    try {
      if (dirty) await doSave(contentRef.current, activeId);
      await saveAsTemplate(activeId);
      const tpls = await fetchDocuments(project, { template: true });
      setTemplates(tpls);
    } catch (e) {
      setError(String(e));
    }
  }, [activeId, dirty, doSave, project]);

  const handleCreateFromTemplate = useCallback(async (templateId: number, name: string) => {
    try {
      const template = await fetchDocument(templateId);
      const doc = await createDocument(project, name);
      await patchDocument(doc.id, { contentMd: template.contentMd });
      await reload();
      handleSelect(doc.id);
    } catch (e) {
      setError(String(e));
    }
  }, [project, reload]);

  const handleDeleteTemplate = useCallback(async (id: number) => {
    try {
      await deleteDocument(id);
      const tpls = await fetchDocuments(project, { template: true });
      setTemplates(tpls);
    } catch (e) {
      setError(String(e));
    }
  }, [project]);

  const handleRenameTemplate = useCallback(async (id: number, name: string) => {
    try {
      await patchDocument(id, { name });
      setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleWhiteboardPick = useCallback((whiteboardId: number, wbMode: "live" | "static") => {
    setShowWbPicker(false);
    const html = `<div data-whiteboard-embed data-whiteboard-id="${whiteboardId}" data-mode="${wbMode}"></div>`;
    editorRef.current?.insertHtml(html);
  }, []);

  const extractMarkdown = (text: string): string | null => {
    const fenceMatch = text.match(/```markdown?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) return fenceMatch[1]!;
    return text.trim() || null;
  };

  const handleSend = async (prompt: string) => {
    if (activeId === null) return;
    setError(null);

    if (mode === "question") {
      setStreaming(true);
      try {
        if (dirty) await doSave(contentRef.current, activeId);
        const res = await askDocument(activeId, {
          prompt,
          contentMd: contentRef.current,
        });
        onOpenInChat(res.sessionId, {
          prompt: res.prompt,
          attachments: res.attachments,
          isQuickChat: res.isQuickChat,
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setStreaming(false);
      }
      return;
    }

    // Edit mode: stream the agent response
    setStreaming(true);
    try {
      const res = await editDocument(activeId, { prompt, contentMd: contentRef.current });

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

      const md = extractMarkdown(fullContent);
      if (!md) {
        setError("Could not extract markdown from the response");
        setStreaming(false);
        return;
      }

      setContentMd(md);
      lastSavedRef.current = md;
      editorRef.current?.setMarkdown(md);
      await patchDocument(activeId, { contentMd: md });
      setDocuments((prev) =>
        prev.map((d) => (d.id === activeId ? { ...d, updatedAt: Date.now() } : d)),
      );
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="doc-tab">
      <DocumentSidebar
        documents={documents}
        templates={templates}
        activeId={activeId}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
        onCreateFromTemplate={handleCreateFromTemplate}
        onDeleteTemplate={handleDeleteTemplate}
        onRenameTemplate={handleRenameTemplate}
      />
      <div className="doc-tab__main">
        {activeId !== null ? (
          <DocumentBody
            project={project}
            currentUser={currentUser}
            activeId={activeId}
            contentMd={contentMd}
            activeOriginalLang={activeOriginalLang}
            editorRef={editorRef}
            handleContentChange={handleContentChange}
            handleExport={handleExport}
            onInsertWhiteboard={() => setShowWbPicker(true)}
            handleSaveAsTemplate={handleSaveAsTemplate}
            streaming={streaming}
            error={error}
            setError={setError}
            mode={mode}
            setMode={setMode}
            handleSend={handleSend}
            handleManualSave={handleManualSave}
            dirty={dirty}
          />
        ) : (
          <div className="doc-tab__empty">
            <h2>No documents yet</h2>
            <p>Create one to get started.</p>
          </div>
        )}
      </div>
      {showWbPicker && (
        <WhiteboardPickerDialog
          project={project}
          onPick={handleWhiteboardPick}
          onClose={() => setShowWbPicker(false)}
        />
      )}
    </div>
  );
}

interface DocumentBodyProps {
  project: string;
  currentUser: AuthUser;
  activeId: number;
  contentMd: string;
  activeOriginalLang: string | null;
  editorRef: React.RefObject<DocumentEditorHandle | null>;
  handleContentChange: (md: string) => void;
  handleExport: (format: "docx" | "html" | "pdf") => Promise<void>;
  onInsertWhiteboard: () => void;
  handleSaveAsTemplate: () => Promise<void>;
  streaming: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  mode: "edit" | "question";
  setMode: (m: "edit" | "question") => void;
  handleSend: (prompt: string) => Promise<void>;
  handleManualSave: () => Promise<void>;
  dirty: boolean;
}

/**
 * Document body with a language tabstrip above the editor. On the source-lang
 * tab the Tiptap editor owns the content; other tabs render the translated
 * markdown read-only via `<MarkdownContent>` with a "Translate now" button.
 */
function DocumentBody(p: DocumentBodyProps) {
  const tr = useTranslations(
    "document",
    p.activeId,
    p.project,
    p.currentUser,
    p.activeOriginalLang,
  );
  const showTabs = !!p.activeOriginalLang && tr.languages.length > 1;
  const isSourceActive = !showTabs || tr.isSourceActive;
  const t = tr.activeTranslation;
  const pill: PillStatus = t ? translationStatusToPill(t) : "pending";
  const translatedName = (t?.fields["name"] ?? "") as string;
  const translatedContent = (t?.fields["content_md"] ?? "") as string;

  return (
    <>
      {showTabs && (
        <div className="doc-tab__tabs">
          <LanguageTabs
            languages={tr.languages}
            sourceLang={p.activeOriginalLang!}
            activeLang={tr.activeLang}
            translations={tr.translations}
            onChange={tr.setActiveLang}
          />
        </div>
      )}
      <div className="doc-tab__content">
        {isSourceActive ? (
          <DocumentEditor
            key={p.activeId}
            ref={p.editorRef}
            documentId={p.activeId}
            contentMd={p.contentMd}
            onChange={p.handleContentChange}
            onExport={p.handleExport}
            onInsertWhiteboard={p.onInsertWhiteboard}
            onSaveAsTemplate={p.handleSaveAsTemplate}
          />
        ) : (
          <div className="doc-tab__translation">
            <div className="doc-tab__translation-header">
              <h2 className="doc-tab__translation-title">
                {translatedName || <em>Not translated yet</em>}
              </h2>
              <div className="doc-tab__translation-actions">
                <StatusPill status={pill} />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void tr.translate()}
                  disabled={tr.triggering || t?.status === "translating"}
                >
                  {tr.triggering ? "Sending…" : "Translate now"}
                </button>
              </div>
            </div>
            <div className="doc-tab__translation-hint">
              Read-only translation — switch to the source tab to edit.
            </div>
            {t?.status === "error" && t.error && (
              <div className="doc-tab__error">{t.error}</div>
            )}
            {translatedContent.trim() ? (
              <MarkdownContent text={translatedContent} />
            ) : (
              <div className="lang-readonly lang-readonly--empty">
                No translation yet — click "Translate now" to run it
                immediately, or wait for the next scheduled tick (every 5 min).
              </div>
            )}
          </div>
        )}
      </div>
      {isSourceActive && p.streaming && (
        <div className="doc-tab__overlay">
          <span className="spinner" />
          <span>AI is editing the document...</span>
        </div>
      )}
      {isSourceActive && p.error && (
        <div className="doc-tab__error">
          {p.error}
          <button
            className="doc-tab__error-close"
            onClick={() => p.setError(null)}
          >
            &times;
          </button>
        </div>
      )}
      {isSourceActive && (
        <DocumentComposer
          mode={p.mode}
          onModeChange={p.setMode}
          onSend={p.handleSend}
          onSave={p.handleManualSave}
          streaming={p.streaming}
          dirty={p.dirty}
        />
      )}
    </>
  );
}
