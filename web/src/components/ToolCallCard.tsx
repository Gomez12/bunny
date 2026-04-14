interface Props {
  name: string;
  args: string;
  ok?: boolean;
  output?: string;
  error?: string;
}

export default function ToolCallCard({ name, args, ok, output, error }: Props) {
  const status = ok === undefined ? "running" : ok ? "ok" : "error";
  return (
    <div className={`toolcall toolcall--${status}`}>
      <div className="toolcall__head">
        <span className="toolcall__icon">⚙</span>
        <span className="toolcall__name">{name}</span>
        <span className="toolcall__status">
          {status === "running" ? "…" : status === "ok" ? "✓" : "✗"}
        </span>
      </div>
      {args.trim() && <pre className="toolcall__args">{args}</pre>}
      {output && <pre className="toolcall__output">{output}</pre>}
      {error && <pre className="toolcall__error">{error}</pre>}
    </div>
  );
}
