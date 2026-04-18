import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { ResizableImage } from "./tiptap/ResizableImage";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Color from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import { forwardRef, useImperativeHandle, useCallback, useState, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import DocumentRibbon from "./DocumentRibbon";
import WhiteboardEmbed from "./tiptap/WhiteboardEmbedNode";
import { uploadDocumentImage } from "../api";

export interface DocumentEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  insertHtml: (html: string) => void;
}

interface Props {
  documentId: number;
  contentMd: string;
  onChange: (md: string) => void;
  onExport?: (format: "docx" | "html" | "pdf") => void;
  onInsertWhiteboard?: () => void;
  onSaveAsTemplate?: () => void;
}

function getEditorMarkdown(editor: Editor): string {
  return (editor.storage as any).markdown.getMarkdown();
}

const DocumentEditor = forwardRef<DocumentEditorHandle, Props>(function DocumentEditor(
  { documentId, contentMd, onChange, onExport, onInsertWhiteboard, onSaveAsTemplate },
  ref,
) {
  const [viewMode, setViewMode] = useState<"wysiwyg" | "code">("wysiwyg");
  const [codeContent, setCodeContent] = useState("");
  const suppressChangeRef = useRef(false);
  const docIdRef = useRef(documentId);
  docIdRef.current = documentId;

  // Stable refs so Tiptap closures always call the latest versions
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editorRef = useRef<Editor | null>(null);
  const lastExternalMd = useRef(contentMd);

  const handleImageFiles = useCallback(async (files: File[]) => {
    const ed = editorRef.current;
    if (!ed) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const { url } = await uploadDocumentImage(docIdRef.current, file);
        ed.chain().focus().insertContent({
          type: "image",
          attrs: { src: url, alt: file.name },
        }).run();
      } catch {
        // silent — user can retry
      }
    }
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      ResizableImage,
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight,
      Color,
      TextStyle,
      Placeholder.configure({ placeholder: "Start writing..." }),
      TaskList,
      TaskItem.configure({ nested: true }),
      WhiteboardEmbed,
      Markdown.configure({
        html: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: contentMd,
    onUpdate: ({ editor: e }) => {
      if (suppressChangeRef.current) return;
      const md = getEditorMarkdown(e as Editor);
      lastExternalMd.current = md;
      onChangeRef.current(md);
    },
    editorProps: {
      handleDrop: (_view, event, _slice, moved) => {
        if (moved || !event.dataTransfer?.files.length) return false;
        const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        if (files.length === 0) return false;
        event.preventDefault();
        void handleImageFiles(files);
        return true;
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const files: File[] = [];
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length === 0) return false;
        event.preventDefault();
        void handleImageFiles(files);
        return true;
      },
    },
  });

  // Keep the editor ref in sync
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Sync external content changes (e.g. after AI edit)
  useEffect(() => {
    if (!editor || contentMd === lastExternalMd.current) return;
    lastExternalMd.current = contentMd;
    suppressChangeRef.current = true;
    editor.commands.setContent(contentMd);
    suppressChangeRef.current = false;
    if (viewMode === "code") setCodeContent(contentMd);
  }, [contentMd, editor, viewMode]);

  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      if (viewMode === "code") return codeContent;
      if (!editor) return contentMd;
      return getEditorMarkdown(editor);
    },
    setMarkdown: (md: string) => {
      lastExternalMd.current = md;
      if (editor) {
        suppressChangeRef.current = true;
        editor.commands.setContent(md);
        suppressChangeRef.current = false;
      }
      setCodeContent(md);
      onChangeRef.current(md);
    },
    insertHtml: (html: string) => {
      if (editor) {
        editor.chain().focus().insertContent(html).run();
      }
    },
  }));

  const handleViewModeChange = useCallback((mode: "wysiwyg" | "code") => {
    if (mode === viewMode) return;
    if (mode === "code" && editor) {
      setCodeContent(getEditorMarkdown(editor));
    }
    if (mode === "wysiwyg" && editor) {
      suppressChangeRef.current = true;
      editor.commands.setContent(codeContent);
      suppressChangeRef.current = false;
      onChange(codeContent);
    }
    setViewMode(mode);
  }, [viewMode, editor, codeContent, onChange]);

  const handleCodeChange = useCallback((value: string) => {
    setCodeContent(value);
    onChange(value);
  }, [onChange]);

  const handleImageInsert = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => {
      if (input.files) {
        void handleImageFiles(Array.from(input.files));
      }
    };
    input.click();
  }, [handleImageFiles]);

  return (
    <div className="doc-editor">
      <DocumentRibbon
        editor={editor}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onInsertImage={handleImageInsert}
        onExport={onExport}
        onInsertWhiteboard={onInsertWhiteboard}
        onSaveAsTemplate={onSaveAsTemplate}
      />
      {viewMode === "wysiwyg" ? (
        <div className="doc-editor__content">
          <EditorContent editor={editor} />
        </div>
      ) : (
        <div className="doc-editor__code">
          <textarea
            value={codeContent}
            onChange={(e) => handleCodeChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
});

export default DocumentEditor;
