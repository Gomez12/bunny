import { useRef, type FormEvent, type KeyboardEvent } from "react";

type Mode = "edit" | "question";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onSend: (prompt: string) => void;
  onSave: () => void;
  streaming: boolean;
  dirty: boolean;
}

export default function WhiteboardComposer({
  mode,
  onModeChange,
  onSend,
  onSave,
  streaming,
  dirty,
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
    <div className="wb-composer">
      <div className="wb-composer__mode">
        <button
          className={`wb-composer__mode-btn${mode === "edit" ? " wb-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("edit")}
          title="Edit whiteboard via AI"
        >
          Edit
        </button>
        <button
          className={`wb-composer__mode-btn${mode === "question" ? " wb-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("question")}
          title="Ask a question about the whiteboard (opens in Chat)"
        >
          Question
        </button>
      </div>
      <form className="wb-composer__form" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          className="wb-composer__input"
          placeholder={
            mode === "edit"
              ? "Describe changes to the whiteboard…"
              : "Ask a question about the whiteboard…"
          }
          rows={1}
          disabled={streaming}
          onKeyDown={handleKeyDown}
        />
        <button
          className="btn btn--accent wb-composer__send"
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
      <button
        className={`btn wb-composer__save${dirty ? " wb-composer__save--dirty" : ""}`}
        onClick={onSave}
        disabled={!dirty || streaming}
        title={dirty ? "Save whiteboard" : "No unsaved changes"}
      >
        Save
      </button>
    </div>
  );
}
