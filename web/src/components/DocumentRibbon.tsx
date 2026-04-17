import type { Editor } from "@tiptap/react";

interface Props {
  editor: Editor | null;
  viewMode: "wysiwyg" | "code";
  onViewModeChange: (mode: "wysiwyg" | "code") => void;
  onInsertImage?: () => void;
  onExport?: (format: "docx" | "html" | "pdf") => void;
  onInsertWhiteboard?: () => void;
  onSaveAsTemplate?: () => void;
}

export default function DocumentRibbon({ editor, viewMode, onViewModeChange, onInsertImage, onExport, onInsertWhiteboard, onSaveAsTemplate }: Props) {
  if (!editor) return null;

  const btn = (
    label: string,
    action: () => void,
    active: boolean,
    title?: string,
  ) => (
    <button
      className={`doc-ribbon__btn${active ? " doc-ribbon__btn--active" : ""}`}
      onClick={action}
      title={title ?? label}
      type="button"
    >
      {label}
    </button>
  );

  const isDisabled = viewMode === "code";

  return (
    <div className="doc-ribbon">
      {/* Text formatting */}
      <div className="doc-ribbon__group">
        {btn("B", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"), "Bold")}
        {btn("I", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"), "Italic")}
        {btn("U", () => editor.chain().focus().toggleUnderline().run(), editor.isActive("underline"), "Underline")}
        {btn("S", () => editor.chain().focus().toggleStrike().run(), editor.isActive("strike"), "Strikethrough")}
      </div>

      {/* Headings */}
      <div className="doc-ribbon__group">
        <select
          className="doc-ribbon__select"
          value={
            editor.isActive("heading", { level: 1 }) ? "1" :
            editor.isActive("heading", { level: 2 }) ? "2" :
            editor.isActive("heading", { level: 3 }) ? "3" :
            editor.isActive("heading", { level: 4 }) ? "4" :
            "p"
          }
          onChange={(e) => {
            const val = e.target.value;
            if (val === "p") {
              editor.chain().focus().setParagraph().run();
            } else {
              editor.chain().focus().toggleHeading({ level: Number(val) as 1 | 2 | 3 | 4 }).run();
            }
          }}
          disabled={isDisabled}
        >
          <option value="p">Paragraph</option>
          <option value="1">Heading 1</option>
          <option value="2">Heading 2</option>
          <option value="3">Heading 3</option>
          <option value="4">Heading 4</option>
        </select>
      </div>

      {/* Lists */}
      <div className="doc-ribbon__group">
        {btn("\u2022", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"), "Bullet list")}
        {btn("1.", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"), "Ordered list")}
        {btn("\u2611", () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"), "Task list")}
      </div>

      {/* Alignment */}
      <div className="doc-ribbon__group">
        {btn("\u2261", () => editor.chain().focus().setTextAlign("left").run(), editor.isActive({ textAlign: "left" }), "Align left")}
        {btn("\u2263", () => editor.chain().focus().setTextAlign("center").run(), editor.isActive({ textAlign: "center" }), "Center")}
        {btn("\u2262", () => editor.chain().focus().setTextAlign("right").run(), editor.isActive({ textAlign: "right" }), "Align right")}
      </div>

      {/* Block formatting */}
      <div className="doc-ribbon__group">
        {btn("\u201C", () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"), "Blockquote")}
        {btn("<>", () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive("codeBlock"), "Code block")}
        {btn("\u2015", () => editor.chain().focus().setHorizontalRule().run(), false, "Horizontal rule")}
      </div>

      {/* Insert */}
      <div className="doc-ribbon__group">
        {btn("\u2637", () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), false, "Insert table")}
        {onInsertImage && btn("\u{1F5BC}", onInsertImage, false, "Insert image")}
        {onInsertWhiteboard && btn("\u{1F3A8}", onInsertWhiteboard, false, "Insert whiteboard")}
      </div>

      {/* Export */}
      {onExport && (
        <div className="doc-ribbon__group">
          <select
            className="doc-ribbon__select"
            value=""
            onChange={(e) => {
              const val = e.target.value as "docx" | "html" | "pdf";
              if (val) onExport(val);
              e.target.value = "";
            }}
          >
            <option value="" disabled>Export...</option>
            <option value="docx">Word (.docx)</option>
            <option value="pdf">PDF</option>
            <option value="html">HTML (.zip)</option>
          </select>
        </div>
      )}

      {/* Save as template */}
      {onSaveAsTemplate && (
        <div className="doc-ribbon__group">
          {btn("\u{1F4CB}", onSaveAsTemplate, false, "Save as template")}
        </div>
      )}

      {/* Mode toggle */}
      <div className="doc-editor__toggle">
        <button
          className={`doc-editor__toggle-btn${viewMode === "wysiwyg" ? " doc-editor__toggle-btn--active" : ""}`}
          onClick={() => onViewModeChange("wysiwyg")}
          type="button"
        >
          Visual
        </button>
        <button
          className={`doc-editor__toggle-btn${viewMode === "code" ? " doc-editor__toggle-btn--active" : ""}`}
          onClick={() => onViewModeChange("code")}
          type="button"
        >
          Code
        </button>
      </div>
    </div>
  );
}
