import { useRef, type FormEvent, type KeyboardEvent } from "react";

type Mode = "edit" | "question";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onSend: (prompt: string) => void;
  onSave?: () => void;
  streaming: boolean;
  dirty?: boolean;
  editPlaceholder?: string;
  questionPlaceholder?: string;
}

export default function DocumentComposer({
  mode,
  onModeChange,
  onSend,
  onSave,
  streaming,
  dirty,
  editPlaceholder,
  questionPlaceholder,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = inputRef.current?.value.trim();
    if (!value || streaming) return;
    onSend(value);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="doc-composer">
      <div className="doc-composer__mode">
        <button
          className={`doc-composer__mode-btn${mode === "edit" ? " doc-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("edit")}
          title="Edit document via AI"
        >
          Edit
        </button>
        <button
          className={`doc-composer__mode-btn${mode === "question" ? " doc-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("question")}
          title="Ask a question about the document (opens in Chat)"
        >
          Question
        </button>
      </div>
      <form className="doc-composer__form" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          className="doc-composer__input"
          placeholder={
            mode === "edit"
              ? (editPlaceholder ?? "Describe changes to the document...")
              : (questionPlaceholder ?? "Ask a question about the document...")
          }
          rows={1}
          disabled={streaming}
          onKeyDown={handleKeyDown}
        />
        <button
          className="btn btn--accent doc-composer__send"
          type="submit"
          disabled={streaming}
        >
          {streaming ? (
            <span className="spinner" />
          ) : (
            "Send"
          )}
        </button>
      </form>
      {onSave && (
        <button
          className={`btn doc-composer__save${dirty ? " doc-composer__save--dirty" : ""}`}
          onClick={onSave}
          disabled={!dirty || streaming}
          title={dirty ? "Save document" : "No unsaved changes"}
        >
          Save
        </button>
      )}
    </div>
  );
}
