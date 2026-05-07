import { useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";

type Mode = "edit" | "question";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onSend: (prompt: string) => void;
  streaming: boolean;
  dirty?: boolean;
  onSave?: () => void;
}

export default function DiagramComposer({
  mode,
  onModeChange,
  onSend,
  streaming,
  dirty,
  onSave,
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
    <div className="entity-composer">
      <div className="entity-composer__mode">
        <button
          type="button"
          className={`entity-composer__mode-btn${mode === "edit" ? " entity-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("edit")}
          title="Edit diagram via AI"
        >
          Edit
        </button>
        <button
          type="button"
          className={`entity-composer__mode-btn${mode === "question" ? " entity-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("question")}
          title="Ask a question (opens in Chat)"
        >
          Question
        </button>
      </div>
      <form className="entity-composer__form" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          className="entity-composer__input"
          placeholder={
            mode === "edit"
              ? "Describe a change… (Enter to send)"
              : "Ask a question about this diagram… (opens Chat)"
          }
          rows={1}
          disabled={streaming}
          onKeyDown={handleKeyDown}
        />
        <button
          className="btn btn--accent entity-composer__send"
          type="submit"
          disabled={streaming}
        >
          {streaming ? <span className="spinner" /> : "Send"}
        </button>
      </form>
      {onSave && (
        <button
          className={`btn entity-composer__save${dirty ? " entity-composer__save--dirty" : ""}`}
          onClick={onSave}
          disabled={!dirty || streaming}
          title={dirty ? "Save changes" : "No unsaved changes"}
        >
          Save
        </button>
      )}
    </div>
  );
}
