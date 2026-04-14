import { useRef, useState, type KeyboardEvent } from "react";

interface Props {
  disabled: boolean;
  onSubmit: (prompt: string) => void;
  onAbort?: () => void;
  streaming: boolean;
}

export default function Composer({ disabled, streaming, onSubmit, onAbort }: Props) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
    taRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={taRef}
        className="composer__input"
        placeholder="Message bunny… (Enter to send, Shift+Enter for newline)"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled && !streaming}
      />
      {streaming ? (
        <button type="button" className="btn btn--stop" onClick={onAbort}>
          <span className="spinner spinner--on-dark" /> Stop
        </button>
      ) : (
        <button type="submit" className="btn btn--send" disabled={!value.trim() || disabled}>
          Send
        </button>
      )}
    </form>
  );
}
