import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  Agent,
  CalendarException,
  ExceptionKind,
  Project,
  ProjectVisibility,
} from "../api";
import {
  createProjectCalendarException,
  deleteCalendarException,
  listProjectCalendarExceptions,
  patchCalendarException,
} from "../api";
// Cross-root import: vite is configured with fs.allow: [".."] so the frontend
// can pin itself to the backend's validation rule instead of drifting.
import { PROJECT_NAME_RE } from "../../../src/memory/project_name";
import { validateOverride } from "../lib/forms";
import Modal from "./Modal";
import ProjectPromptsSection from "./ProjectPromptsSection";
import CalendarExceptionEditor from "./CalendarExceptionEditor";

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
  const { t } = useTranslation();
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
      setError(t("dialog.project.errNameSlug"));
      return;
    }
    const parsedLastN = validateOverride(lastN);
    const parsedRecallK = validateOverride(recallK);
    if (parsedLastN === undefined || parsedRecallK === undefined) {
      setError(t("dialog.project.errMemoryOverride"));
      return;
    }
    if (languages.length === 0) {
      setError(t("dialog.project.errLanguagePick"));
      return;
    }
    if (!languages.includes(defaultLanguage)) {
      setError(t("dialog.project.errDefaultLangNotInSet"));
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
          title={
            mode === "create"
              ? t("dialog.project.titleCreate")
              : t("dialog.project.titleEdit", { name: initial?.name ?? "" })
          }
        />

        <label className="project-form__field">
          <span>{t("dialog.project.nameLabel")}</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            disabled={mode === "edit"}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dialog.project.namePlaceholder")}
            autoComplete="off"
            required
          />
          {!nameValid && name !== "" && (
            <span className="project-form__hint project-form__hint--error">
              {t("dialog.project.nameInlineErr")}
            </span>
          )}
        </label>

        <label className="project-form__field">
          <span>{t("dialog.project.descriptionLabel")}</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("dialog.project.descriptionPlaceholder")}
          />
        </label>

        <label className="project-form__field">
          <span>{t("dialog.project.systemPromptLabel")}</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={8}
            placeholder={t("dialog.project.systemPromptPlaceholder")}
          />
        </label>

        <div className="project-form__row">
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={appendMode}
              onChange={(e) => setAppendMode(e.target.checked)}
            />
            <span>{t("dialog.project.appendMode")}</span>
          </label>

          <label className="project-form__choice">
            <span>{t("dialog.project.visibilityLabel")}</span>
            <select
              value={visibility}
              onChange={(e) =>
                setVisibility(e.target.value as ProjectVisibility)
              }
            >
              <option value="public">{t("dialog.project.visibilityPublic")}</option>
              <option value="private">{t("dialog.project.visibilityPrivate")}</option>
            </select>
          </label>
        </div>

        <div className="project-form__row">
          <label className="project-form__field">
            <span>{t("dialog.project.lastNLabel")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={lastN}
              onChange={(e) => setLastN(e.target.value)}
              placeholder={t("dialog.project.lastNPlaceholder")}
            />
            <span className="project-form__hint">{t("dialog.project.lastNHint")}</span>
          </label>

          <label className="project-form__field">
            <span>{t("dialog.project.recallKLabel")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={recallK}
              onChange={(e) => setRecallK(e.target.value)}
              placeholder={t("dialog.project.recallKPlaceholder")}
            />
            <span className="project-form__hint">{t("dialog.project.recallKHint")}</span>
          </label>
        </div>

        <label className="project-form__field">
          <span>{t("dialog.project.languagesLabel")}</span>
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
          <span className="project-form__hint">{t("dialog.project.languagesHint")}</span>
        </label>

        <label className="project-form__field">
          <span>{t("dialog.project.defaultLanguageLabel")}</span>
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
          <span className="project-form__hint">{t("dialog.project.defaultLanguageHint")}</span>
        </label>

        <label className="project-form__field">
          <span>{t("dialog.project.availableAgentsLabel")}</span>
          {allAgents.length === 0 ? (
            <span className="project-form__hint">{t("dialog.project.noAgentsHint")}</span>
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
            <Trans
              i18nKey="dialog.project.agentsHint"
              components={{ code: <code /> }}
            />
          </span>
        </label>

        <label className="project-form__field">
          <span>{t("dialog.project.businessesLabel")}</span>
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={autoBuildBusinesses}
              onChange={(e) => setAutoBuildBusinesses(e.target.checked)}
            />
            <span>{t("dialog.project.autoBuildLabel")}</span>
          </label>
          <span className="project-form__hint">
            <Trans
              i18nKey="dialog.project.autoBuildHint"
              components={{ code: <code /> }}
            />
          </span>
        </label>

        {mode === "edit" && initial && (
          <ProjectPromptsSection project={initial.name} />
        )}

        {mode === "edit" && initial && (
          <ProjectCalendarSection projectName={initial.name} />
        )}

        {error && <div className="project-form__error">{error}</div>}

        <Modal.Footer>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={submitting}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--send"
            disabled={submitting || !nameValid}
          >
            {submitting
              ? t("common.saving")
              : mode === "create"
                ? t("common.create")
                : t("common.save")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function ProjectCalendarSection({ projectName }: { projectName: string }) {
  const { t } = useTranslation();
  const [exceptions, setExceptions] = useState<CalendarException[]>([]);

  const reload = useCallback(async () => {
    try {
      setExceptions(await listProjectCalendarExceptions(projectName));
    } catch {
      // non-fatal; calendar section is supplementary
    }
  }, [projectName]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="project-form__section">
      <h3 className="project-form__section-title">{t("dialog.project.calendarSection")}</h3>
      <p className="project-form__hint">{t("dialog.project.calendarHint")}</p>
      <CalendarExceptionEditor
        exceptions={exceptions}
        canEdit
        scope="project"
        scopeId={projectName}
        onAdd={async (date: string, kind: ExceptionKind, name: string) => {
          await createProjectCalendarException(projectName, { date, kind, name });
          await reload();
        }}
        onUpdate={async (id: number, patch: { kind?: ExceptionKind; name?: string }) => {
          await patchCalendarException("project", id, patch, projectName);
          await reload();
        }}
        onDelete={async (id: number) => {
          await deleteCalendarException("project", id, projectName);
          await reload();
        }}
      />
    </div>
  );
}
