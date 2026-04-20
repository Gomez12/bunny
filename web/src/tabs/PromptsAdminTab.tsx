import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listGlobalPrompts,
  updateGlobalPrompt,
  type PromptDto,
} from "../api";
import { AlertCircle, ICON_DEFAULTS, Loader2, RotateCcw } from "../lib/icons";

/** Group prompts by namespace prefix (text before the first dot). */
function groupByNamespace(prompts: PromptDto[]): Array<[string, PromptDto[]]> {
  const groups = new Map<string, PromptDto[]>();
  for (const p of prompts) {
    const ns = p.key.split(".")[0] ?? p.key;
    let list = groups.get(ns);
    if (!list) {
      list = [];
      groups.set(ns, list);
    }
    list.push(p);
  }
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

const NS_LABEL: Record<string, string> = {
  agent: "Agent system prompt fragments",
  contact: "Contacts",
  document: "Documents",
  kb: "Knowledge Base",
  tools: "Tool descriptions",
  web_news: "Web News",
  whiteboard: "Whiteboard",
};

export default function PromptsAdminTab() {
  const [prompts, setPrompts] = useState<PromptDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setPrompts(await listGlobalPrompts());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(
    () => (prompts ? groupByNamespace(prompts) : []),
    [prompts],
  );

  if (prompts === null && !error) {
    return (
      <div className="prompts-admin">
        <Loader2 {...ICON_DEFAULTS} className="spin" /> Loading prompts…
      </div>
    );
  }

  return (
    <div className="prompts-admin">
      <header className="prompts-admin__intro">
        <h2>Prompts</h2>
        <p className="muted">
          Edit the LLM prompts Bunny sends for KB definitions, documents,
          whiteboards, contacts, Web News fetches, and the built-in tool
          descriptions. Leave a field blank (or press <em>Reset to default</em>)
          to fall back to the hardcoded registry value.
        </p>
      </header>
      {error && <div className="auth-error">{error}</div>}
      {groups.map(([ns, items]) => (
        <section key={ns} className="prompts-group">
          <h3>{NS_LABEL[ns] ?? ns}</h3>
          <ul className="prompts-list">
            {items.map((p) => (
              <PromptRow key={p.key} prompt={p} onSaved={reload} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PromptRow({
  prompt,
  onSaved,
}: {
  prompt: PromptDto;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<string>(prompt.global ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(prompt.global ?? "");
  }, [prompt.key, prompt.global]);

  const dirty = draft !== (prompt.global ?? "");
  const isOverridden = prompt.global !== null;

  const save = async () => {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const next = draft.trim() === "" ? null : draft;
      await updateGlobalPrompt(prompt.key, next);
      setMsg(next === null ? "Reset to default." : "Saved.");
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = () => {
    setDraft("");
  };

  return (
    <li className="prompts-row">
      <div className="prompts-row__head">
        <code className="prompts-row__key">{prompt.key}</code>
        {isOverridden && <span className="chip">overridden</span>}
        {prompt.variables && prompt.variables.length > 0 && (
          <span className="chip chip--ghost">
            vars: {prompt.variables.map((v) => `{{${v}}}`).join(" ")}
          </span>
        )}
      </div>
      <p className="muted prompts-row__desc">{prompt.description}</p>
      {prompt.warnsJsonContract && (
        <div className="prompts-warn prompts-warn--red">
          <AlertCircle {...ICON_DEFAULTS} />
          Edits risk breaking the output parser — this prompt must produce a
          specific JSON / markdown / SVG shape.
        </div>
      )}
      {prompt.warnsTokenCost && (
        <div className="prompts-warn prompts-warn--yellow">
          <AlertCircle {...ICON_DEFAULTS} />
          Sent in the tool schema on every turn — long text adds real token
          cost to every agent call.
        </div>
      )}
      <textarea
        className="prompts-row__textarea"
        value={draft}
        rows={Math.min(24, Math.max(4, draft.split("\n").length + 1))}
        placeholder={prompt.defaultText}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
      />
      <div className="prompts-row__actions">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={saving || (!isOverridden && draft === "")}
          onClick={resetToDefault}
          title="Clear override — falls back to the registry default"
        >
          <RotateCcw {...ICON_DEFAULTS} /> Reset to default
        </button>
        {msg && <span className="auth-ok">{msg}</span>}
        {err && <span className="auth-error">{err}</span>}
      </div>
    </li>
  );
}
