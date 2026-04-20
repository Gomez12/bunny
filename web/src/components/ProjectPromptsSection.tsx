import { useEffect, useState } from "react";
import {
  listProjectPrompts,
  updateProjectPrompt,
  type PromptDto,
} from "../api";
import { AlertCircle, ICON_DEFAULTS, Loader2, RotateCcw } from "../lib/icons";

/**
 * Per-project prompt editor dropped into the Project dialog. Lazy-loads the
 * list on first expand so the dialog stays cheap for projects whose prompts
 * are never touched.
 */
export default function ProjectPromptsSection({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<PromptDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || prompts !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProjectPrompts(project);
        if (!cancelled) setPrompts(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, prompts, project]);

  const refresh = async () => {
    setError(null);
    try {
      setPrompts(await listProjectPrompts(project));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const overriddenCount = prompts
    ? prompts.filter((p) => p.override !== null).length
    : 0;

  return (
    <section className="project-prompts">
      <button
        type="button"
        className="project-prompts__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Prompt overrides</span>
        <span className="muted">
          {prompts === null
            ? "(tap to load)"
            : overriddenCount === 0
              ? "(inheriting globals)"
              : `(${overriddenCount} overridden)`}
        </span>
      </button>
      {open && (
        <div className="project-prompts__body">
          {error && <div className="project-form__error">{error}</div>}
          {prompts === null && !error && (
            <div className="muted">
              <Loader2 {...ICON_DEFAULTS} className="spin" /> Loading…
            </div>
          )}
          {prompts && (
            <ul className="prompts-list">
              {prompts.map((p) => (
                <ProjectPromptRow
                  key={p.key}
                  project={project}
                  prompt={p}
                  onSaved={refresh}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function ProjectPromptRow({
  project,
  prompt,
  onSaved,
}: {
  project: string;
  prompt: PromptDto;
  onSaved: () => void | Promise<void>;
}) {
  const isOverridden = prompt.override !== null;
  const [inherit, setInherit] = useState(!isOverridden);
  const [draft, setDraft] = useState<string>(
    prompt.override ?? prompt.global ?? prompt.defaultText,
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setInherit(!isOverridden);
    setDraft(prompt.override ?? prompt.global ?? prompt.defaultText);
  }, [isOverridden, prompt.key, prompt.override, prompt.global, prompt.defaultText]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      if (inherit) {
        await updateProjectPrompt(project, prompt.key, null);
        setMsg("Cleared — inheriting global / default.");
      } else {
        await updateProjectPrompt(project, prompt.key, draft);
        setMsg("Saved.");
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const dirty = inherit ? isOverridden : draft !== (prompt.override ?? "");

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
      <label className="project-form__choice">
        <input
          type="checkbox"
          checked={inherit}
          onChange={(e) => setInherit(e.target.checked)}
        />
        <span>Inherit (use global override or registry default)</span>
      </label>
      <textarea
        className="prompts-row__textarea"
        value={inherit ? prompt.global ?? prompt.defaultText : draft}
        readOnly={inherit}
        rows={Math.min(18, Math.max(4, draft.split("\n").length + 1))}
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
        {isOverridden && (
          <button
            type="button"
            className="ghost"
            disabled={saving}
            onClick={() => {
              setInherit(true);
              setDraft(prompt.global ?? prompt.defaultText);
            }}
            title="Revert to the global override or registry default"
          >
            <RotateCcw {...ICON_DEFAULTS} /> Revert to global
          </button>
        )}
        {msg && <span className="auth-ok">{msg}</span>}
        {err && <span className="auth-error">{err}</span>}
      </div>
    </li>
  );
}
