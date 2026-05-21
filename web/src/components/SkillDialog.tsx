import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, Skill, SkillVisibility } from "../api";
import Modal from "./Modal";

export interface SkillDialogValue {
  name: string;
  description: string;
  visibility: SkillVisibility;
  skillMd: string;
  linkedProjects: string[];
}

interface Props {
  mode: "create" | "edit";
  initial?: Skill;
  allProjects: Project[];
  onClose: () => void;
  onSubmit: (value: SkillDialogValue) => Promise<void>;
}

export default function SkillDialog({
  mode,
  initial,
  allProjects,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [visibility, setVisibility] = useState<SkillVisibility>(
    initial?.visibility ?? "private",
  );
  const [skillMd, setSkillMd] = useState(
    initial?.skillMd ?? "---\nname: \ndescription: \n---\n\n# Instructions\n",
  );
  const [linkedProjects, setLinkedProjects] = useState<string[]>(
    initial?.projects ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "create") nameRef.current?.focus();
  }, [mode]);

  const toggleProject = (p: string) => {
    setLinkedProjects((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim().toLowerCase();
    if (!trimmedName) {
      setError(t("dialog.skill.errNameRequired"));
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(trimmedName)) {
      setError(t("dialog.skill.errNameSlug"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: trimmedName,
        description: description.trim(),
        visibility,
        skillMd,
        linkedProjects,
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
              ? t("dialog.skill.titleCreate")
              : t("dialog.skill.titleEdit", { name: initial?.name ?? "" })
          }
        />

        <label className="project-form__field">
          <span>{t("dialog.skill.nameLabel")}</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            disabled={mode === "edit"}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dialog.skill.namePlaceholder")}
            required
          />
        </label>

        <label className="project-form__field">
          <span>{t("dialog.skill.descriptionLabel")}</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("dialog.skill.descriptionPlaceholder")}
          />
        </label>

        <label className="project-form__choice">
          <span>{t("dialog.skill.visibilityLabel")}</span>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as SkillVisibility)}
          >
            <option value="private">{t("dialog.skill.visibilityPrivate")}</option>
            <option value="public">{t("dialog.skill.visibilityPublic")}</option>
          </select>
        </label>

        <label className="project-form__field">
          <span>{t("dialog.skill.skillMdLabel")}</span>
          <textarea
            className="project-form__prompt"
            value={skillMd}
            onChange={(e) => setSkillMd(e.target.value)}
            rows={12}
            spellCheck={false}
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.85rem",
            }}
          />
        </label>

        <fieldset className="project-form__fieldset">
          <legend>{t("dialog.skill.projectsLegend")}</legend>
          <div className="project-form__chips">
            {allProjects.map((p) => (
              <label key={p.name} className="project-form__chip">
                <input
                  type="checkbox"
                  checked={linkedProjects.includes(p.name)}
                  onChange={() => toggleProject(p.name)}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

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
          <button type="submit" className="btn btn--send" disabled={submitting}>
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
