import { useRef, type FormEvent, type KeyboardEvent } from "react";

type Mode = "edit" | "question";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onSend: (prompt: string) => void;
  streaming: boolean;
}

export default function ScriptComposer({
  mode,
  onModeChange,
  onSend,
  streaming,
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
          type="button"
          className={`wb-composer__mode-btn${mode === "edit" ? " wb-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("edit")}
          title="Ask the AI to modify the script directly"
        >
          Edit
        </button>
        <button
          type="button"
          className={`wb-composer__mode-btn${mode === "question" ? " wb-composer__mode-btn--active" : ""}`}
          onClick={() => onModeChange("question")}
          title="Open a chat session about this script"
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
              ? "Describe a change to the script… (Enter to send)"
              : "Ask a question about the script… (opens Chat)"
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
          {streaming ? <span className="spinner" /> : "Send"}
        </button>
      </form>
    </div>
  );
}
