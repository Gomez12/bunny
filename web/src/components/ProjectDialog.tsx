import { useEffect, useRef, useState } from "react";
import type { Agent, Project, ProjectVisibility } from "../api";
// Cross-root import: vite is configured with fs.allow: [".."] so the frontend
// can pin itself to the backend's validation rule instead of drifting.
import { PROJECT_NAME_RE } from "../../../src/memory/project_name";
import { validateOverride } from "../lib/forms";
import Modal from "./Modal";
import ProjectPromptsSection from "./ProjectPromptsSection";

export interface ProjectDialogValue {
  name: string;
  description: string;
  systemPrompt: string;
  appendMode: boolean;
  visibility: ProjectVisibility;
  /** null = inherit the global [memory] default. */
  lastN: number | null;
  /** null = inherit the global [memory] default. */
  recallK: number | null;
  /** ISO 639-1 codes supported by the project. */
  languages: string[];
  /** Must be a member of `languages`. */
  defaultLanguage: string;
  /** Agent names that should be linked to this project after submit. */
  linkedAgents: string[];
  /** Per-project opt-in for the business.auto_build handler (ADR 0036). */
  autoBuildBusinesses: boolean;
}

/** Curated list of ISO 639-1 codes with English display names. Extend freely —
 * any valid 2-letter code would work server-side, this is just the picker. */
const LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "nl", name: "Nederlands" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "sv", name: "Svenska" },
  { code: "no", name: "Norsk" },
  { code: "da", name: "Dansk" },
  { code: "pl", name: "Polski" },
  { code: "fi", name: "Suomi" },
  { code: "tr", name: "Türkçe" },
  { code: "ja", name: "日本語" },
  { code: "zh", name: "中文" },
  { code: "ko", name: "한국어" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
];

interface Props {
  mode: "create" | "edit";
  initial?: Project;
  /** All agents visible to the user; their `.projects` field seeds the checkboxes. */
  allAgents?: Agent[];
  onClose: () => void;
  onSubmit: (value: ProjectDialogValue) => Promise<void>;
}

export default function ProjectDialog({
  mode,
  initial,
  allAgents = [],
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [appendMode, setAppendMode] = useState(initial?.appendMode ?? true);
  const [visibility, setVisibility] = useState<ProjectVisibility>(
    initial?.visibility ?? "public",
  );
  const [lastN, setLastN] = useState<string>(
    initial?.lastN == null ? "" : String(initial.lastN),
  );
  const [recallK, setRecallK] = useState<string>(
    initial?.recallK == null ? "" : String(initial.recallK),
  );
  const [languages, setLanguages] = useState<string[]>(
    initial?.languages ?? ["en"],
  );
  const [defaultLanguage, setDefaultLanguage] = useState<string>(
    initial?.defaultLanguage ?? initial?.languages?.[0] ?? "en",
  );
  const [linkedAgents, setLinkedAgents] = useState<string[]>(() => {
    if (!initial) return [];
    return allAgents
      .filter((a) => a.projects.includes(initial.name))
      .map((a) => a.name);
  });
  const [autoBuildBusinesses, setAutoBuildBusinesses] = useState<boolean>(
    initial?.autoBuildBusinesses ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "create") nameRef.current?.focus();
  }, [mode]);

  const nameValid =
    mode === "edit" || PROJECT_NAME_RE.test(name.trim().toLowerCase());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid) {
      setError(
        "Name must be lowercase letters, digits, _ or - (max 63 chars).",
      );
      return;
    }
    const parsedLastN = validateOverride(lastN);
    const parsedRecallK = validateOverride(recallK);
    if (parsedLastN === undefined || parsedRecallK === undefined) {
      setError("Memory overrides must be blank or a non-negative integer.");
      return;
    }
    if (languages.length === 0) {
      setError("Pick at least one language for the project.");
      return;
    }
    if (!languages.includes(defaultLanguage)) {
      setError("Default language must be one of the selected languages.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim().toLowerCase(),
        description: description.trim(),
        systemPrompt,
        appendMode,
        visibility,
        lastN: parsedLastN,
        recallK: parsedRecallK,
        languages,
        defaultLanguage,
        linkedAgents,
        autoBuildBusinesses,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} size="md">
      <form onSubmit={handleSubmit} className="project-form">
        <Modal.Header
          title={mode === "create" ? "New project" : `Edit ${initial?.name}`}
        />

        <label className="project-form__field">
          <span>Name</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            disabled={mode === "edit"}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. research, product-x"
            autoComplete="off"
            required
          />
          {!nameValid && name !== "" && (
            <span className="project-form__hint project-form__hint--error">
              Lowercase, digits, _ or - only (max 63 chars).
            </span>
          )}
        </label>

        <label className="project-form__field">
          <span>Description (optional)</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short summary shown on the card"
          />
        </label>

        <label className="project-form__field">
          <span>System prompt</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={8}
            placeholder="Instructions that apply to every chat in this project"
          />
        </label>

        <div className="project-form__row">
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={appendMode}
              onChange={(e) => setAppendMode(e.target.checked)}
            />
            <span>Append to base prompt (uncheck to replace)</span>
          </label>

          <label className="project-form__choice">
            <span>Visibility</span>
            <select
              value={visibility}
              onChange={(e) =>
                setVisibility(e.target.value as ProjectVisibility)
              }
            >
              <option value="public">Public</option>
              <option value="private">Private (only you)</option>
            </select>
          </label>
        </div>

        <div className="project-form__row">
          <label className="project-form__field">
            <span>Last N turns (verbatim)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={lastN}
              onChange={(e) => setLastN(e.target.value)}
              placeholder="inherit global"
            />
            <span className="project-form__hint">
              How many recent user/assistant turns to replay verbatim. Leave
              blank to inherit.
            </span>
          </label>

          <label className="project-form__field">
            <span>Hybrid recall K</span>
            <input
              type="number"
              min={0}
              step={1}
              value={recallK}
              onChange={(e) => setRecallK(e.target.value)}
              placeholder="inherit global"
            />
            <span className="project-form__hint">
              How many BM25 + vector hits to inject. Leave blank to inherit.
            </span>
          </label>
        </div>

        <label className="project-form__field">
          <span>Languages</span>
          <div className="project-form__chips">
            {LANGUAGE_OPTIONS.map((opt) => {
              const checked = languages.includes(opt.code);
              return (
                <label
                  key={opt.code}
                  className="project-form__chip"
                  title={opt.name}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setLanguages((prev) => {
                        const next = checked
                          ? prev.filter((l) => l !== opt.code)
                          : [...prev, opt.code];
                        if (!next.includes(defaultLanguage)) {
                          setDefaultLanguage(next[0] ?? "en");
                        }
                        return next;
                      })
                    }
                  />
                  <span>
                    {opt.code.toUpperCase()} · {opt.name}
                  </span>
                </label>
              );
            })}
          </div>
          <span className="project-form__hint">
            Every entity is authored in one of these and auto-translated to the
            rest.
          </span>
        </label>

        <label className="project-form__field">
          <span>Default language</span>
          <select
            value={defaultLanguage}
            onChange={(e) => setDefaultLanguage(e.target.value)}
          >
            {languages.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()} ·{" "}
                {LANGUAGE_OPTIONS.find((o) => o.code === l)?.name ?? l}
              </option>
            ))}
          </select>
          <span className="project-form__hint">
            New entities created in this project start in this language unless
            the user has overridden their preferred language.
          </span>
        </label>

        <label className="project-form__field">
          <span>Available agents</span>
          {allAgents.length === 0 ? (
            <span className="project-form__hint">
              No agents yet. Create one in the Agents tab — it is auto-linked to
              the default project.
            </span>
          ) : (
            <div className="project-form__chips">
              {allAgents.map((a) => {
                const checked = linkedAgents.includes(a.name);
                return (
                  <label
                    key={a.name}
                    className="project-form__chip"
                    title={a.description || ""}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setLinkedAgents((prev) =>
                          checked
                            ? prev.filter((n) => n !== a.name)
                            : [...prev, a.name],
                        )
                      }
                    />
                    <span>@{a.name}</span>
                  </label>
                );
              })}
            </div>
          )}
          <span className="project-form__hint">
            Checked agents can be mentioned with <code>@name</code> in this
            project's chats.
          </span>
        </label>

        <label className="project-form__field">
          <span>Businesses</span>
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={autoBuildBusinesses}
              onChange={(e) => setAutoBuildBusinesses(e.target.checked)}
            />
            <span>Auto-build businesses from contacts</span>
          </label>
          <span className="project-form__hint">
            When on, the <code>business.auto_build</code> handler walks this
            project's contacts every six hours, derives organisations from the{" "}
            <code>company</code> field plus email/website domains, and enriches
            new rows via <code>web_search</code>. Off by default to keep
            web-tool cost predictable.
          </span>
        </label>

        {mode === "edit" && initial && (
          <ProjectPromptsSection project={initial.name} />
        )}

        {error && <div className="project-form__error">{error}</div>}

        <Modal.Footer>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--send"
            disabled={submitting || !nameValid}
          >
            {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
