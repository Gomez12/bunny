import { memo, useState } from "react";

interface Props {
  name: string;
  args: string;
  ok?: boolean;
  output?: string;
  error?: string;
  defaultOpen?: boolean;
}

function ToolCallCardImpl({
  name,
  args,
  ok,
  output,
  error,
  defaultOpen = false,
}: Props) {
  const status = ok === undefined ? "running" : ok ? "ok" : "error";
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = args.trim().length > 0 || !!output || !!error;
  return (
    <div className={`toolcall toolcall--${status} ${open ? "toolcall--open" : ""}`}>
      <button
        type="button"
        className="toolcall__head"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasBody}
      >
        <span className="toolcall__caret">{hasBody ? (open ? "▾" : "▸") : "·"}</span>
        <span className="toolcall__icon">⚙</span>
        <span className="toolcall__name">{name}</span>
        <span className="toolcall__status">
          {status === "running" ? "…" : status === "ok" ? "✓" : "✗"}
        </span>
      </button>
      {open && hasBody && (
        <>
          {args.trim() && <pre className="toolcall__args">{args}</pre>}
          {output && <pre className="toolcall__output">{output}</pre>}
          {error && <pre className="toolcall__error">{error}</pre>}
        </>
      )}
    </div>
  );
}

const ToolCallCard = memo(ToolCallCardImpl);
export default ToolCallCard;
