import { useEffect, useRef, useState } from "react";

type MermaidLib = typeof import("mermaid")["default"];

// Lazily load mermaid the first time a diagram is actually rendered; it's a
// ~600KB dep and most chat turns never use it.
let mermaidPromise: Promise<MermaidLib> | undefined;
function loadMermaid(): Promise<MermaidLib> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const m = mod.default;
      m.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "loose",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        flowchart: { useMaxWidth: false, htmlLabels: true, padding: 12 },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        journey: { useMaxWidth: false },
      });
      return m;
    });
  }
  return mermaidPromise;
}

interface Props {
  code: string;
}

export default function MermaidBlock({ code }: Props) {
  const [mode, setMode] = useState<"diagram" | "code">("diagram");
  const [err, setErr] = useState<string | null>(null);
  // Bump on every (re)entry into diagram mode so the <div class="mermaid">
  // gets a brand-new DOM node — mermaid.run() refuses to re-process nodes
  // it has already touched (it marks them with data-processed="true").
  const [pass, setPass] = useState(0);
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (mode !== "diagram") return;
    if (!nodeRef.current) return;
    let cancelled = false;
    setErr(null);
    const node = nodeRef.current;
    loadMermaid()
      .then((m) => {
        if (cancelled) return;
        return m.run({ nodes: [node], suppressErrors: true });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[mermaid]", e);
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, pass, code]);

  const handleToggle = () => {
    setMode((m) => {
      const next = m === "diagram" ? "code" : "diagram";
      if (next === "diagram") setPass((p) => p + 1);
      return next;
    });
  };

  return (
    <div className="mermaid-block">
      <button
        type="button"
        className="mermaid-block__toggle"
        onClick={handleToggle}
        title={mode === "diagram" ? "Show source" : "Render diagram"}
      >
        {mode === "diagram" ? "code" : "diagram"}
      </button>
      {mode === "diagram" ? (
        err ? (
          <div className="mermaid-block__error">
            <div className="mermaid-block__error-msg">Mermaid: {err}</div>
            <pre>
              <code>{code}</code>
            </pre>
          </div>
        ) : (
          <div key={pass} ref={nodeRef} className="mermaid mermaid-block__svg">
            {code}
          </div>
        )
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
