import { useState } from "react";

interface Props {
  text: string;
  defaultOpen?: boolean;
}

export default function ReasoningBlock({ text, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  if (!text.trim()) return null;
  return (
    <div className={`reasoning ${open ? "reasoning--open" : ""}`}>
      <button className="reasoning__toggle" onClick={() => setOpen((o) => !o)}>
        <span className="reasoning__caret">{open ? "▾" : "▸"}</span> thinking
      </button>
      {open && <pre className="reasoning__body">{text}</pre>}
    </div>
  );
}
