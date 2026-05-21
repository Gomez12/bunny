import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  Agent,
  AgentContextScope,
  AgentVisibility,
  Project,
} from "../api";
import { AGENT_NAME_RE } from "../../../src/memory/agent_name";
import { validateOverride } from "../lib/forms";
import Modal from "./Modal";

export interface AgentDialogValue {
  name: string;
  description: string;
  systemPrompt: string;
  appendMode: boolean;
  visibility: AgentVisibility;
  contextScope: AgentContextScope;
  knowsOtherAgents: boolean;
  isSubagent: boolean;
  tools: string[] | null;
  allowedSubagents: string[];
  lastN: number | null;
  recallK: number | null;
  linkedProjects: string[];
}

interface Props {
  mode: "create" | "edit";
  initial?: Agent;
  allTools: string[];
  allProjects: Project[];
  subagentCandidates: Agent[];
  onClose: () => void;
  onSubmit: (value: AgentDialogValue) => Promise<void>;
}

export default function AgentDialog({
  mode,
  initial,
  allTools,
  allProjects,
  subagentCandidates,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [appendMode, setAppendMode] = useState(initial?.appendMode ?? false);
  const [visibility, setVisibility] = useState<AgentVisibility>(
    initial?.visibility ?? "private",
  );
  const [contextScope, setContextScope] = useState<AgentContextScope>(
    initial?.contextScope ?? "full",
  );
  const [knowsOtherAgents, setKnowsOtherAgents] = useState(
    initial?.knowsOtherAgents ?? false,
  );
  const [isSubagent, setIsSubagent] = useState(initial?.isSubagent ?? false);
  // `null` means "inherit every registered tool"; an array is the whitelist.
  const [tools, setTools] = useState<string[] | null>(initial?.tools ?? null);
  const inheritAllTools = tools === null;
  const [allowedSubagents, setAllowedSubagents] = useState<string[]>(
    initial?.allowedSubagents ?? [],
  );
  const [linkedProjects, setLinkedProjects] = useState<string[]>(
    initial?.projects ?? [],
  );
  const [lastN, setLastN] = useState(
    initial?.lastN == null ? "" : String(initial.lastN),
  );
  const [recallK, setRecallK] = useState(
    initial?.recallK == null ? "" : String(initial.recallK),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "create") nameRef.current?.focus();
  }, [mode]);

  const nameValid =
    mode === "edit" || AGENT_NAME_RE.test(name.trim().toLowerCase());

  const subagentOptions = useMemo(
    () =>
      subagentCandidates.filter(
        (a) => a.isSubagent && a.name !== initial?.name,
      ),
    [subagentCandidates, initial?.name],
  );

  const toggle = (list: string[], set: (v: string[]) => void, item: string) => {
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid) {
      setError(t("dialog.agent.errNameSlug"));
      return;
    }
    const parsedLastN = validateOverride(lastN);
    const parsedRecallK = validateOverride(recallK);
    if (parsedLastN === undefined || parsedRecallK === undefined) {
      setError(t("dialog.agent.errMemoryOverride"));
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
        contextScope,
        knowsOtherAgents,
        isSubagent,
        tools,
        allowedSubagents,
        lastN: parsedLastN,
        recallK: parsedRecallK,
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
              ? t("dialog.agent.titleCreate")
              : t("dialog.agent.titleEdit", { name: initial?.name ?? "" })
          }
        />

        <label className="project-form__field">
          <span>{t("dialog.agent.nameLabel")}</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            disabled={mode === "edit"}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("dialog.agent.namePlaceholder")}
            autoComplete="off"
            required
          />
          {!nameValid && name !== "" && (
            <span className="project-form__hint project-form__hint--error">
              {t("dialog.agent.nameInlineErr")}
            </span>
          )}
        </label>

        <label className="project-form__field">
          <span>{t("dialog.agent.descriptionLabel")}</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("dialog.agent.descriptionPlaceholder")}
          />
        </label>

        <label className="project-form__field">
          <span>{t("dialog.agent.systemPromptLabel")}</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={10}
            placeholder={t("dialog.agent.systemPromptPlaceholder")}
          />
        </label>

        <div className="project-form__row">
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={appendMode}
              onChange={(e) => setAppendMode(e.target.checked)}
            />
            <span>{t("dialog.agent.appendMode")}</span>
          </label>
          <label className="project-form__choice">
            <span>{t("dialog.agent.visibilityLabel")}</span>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as AgentVisibility)}
            >
              <option value="private">{t("dialog.agent.visibilityPrivate")}</option>
              <option value="public">{t("dialog.agent.visibilityPublic")}</option>
            </select>
          </label>
        </div>

        <div className="project-form__row">
          <label className="project-form__choice">
            <span>{t("dialog.agent.contextScopeLabel")}</span>
            <select
              value={contextScope}
              onChange={(e) =>
                setContextScope(e.target.value as AgentContextScope)
              }
            >
              <option value="full">{t("dialog.agent.contextScopeFull")}</option>
              <option value="own">{t("dialog.agent.contextScopeOwn")}</option>
            </select>
          </label>
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={knowsOtherAgents}
              onChange={(e) => setKnowsOtherAgents(e.target.checked)}
            />
            <span>{t("dialog.agent.knowsOtherAgents")}</span>
          </label>
        </div>

        <div className="project-form__row">
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={isSubagent}
              onChange={(e) => setIsSubagent(e.target.checked)}
            />
            <span>
              <Trans
                i18nKey="dialog.agent.isSubagent"
                components={{ code: <code /> }}
              />
            </span>
          </label>
        </div>

        <label className="project-form__field">
          <span>{t("dialog.agent.toolsLabel")}</span>
          <label className="project-form__choice">
            <input
              type="checkbox"
              checked={inheritAllTools}
              onChange={(e) => setTools(e.target.checked ? null : [])}
            />
            <span>{t("dialog.agent.inheritAllTools")}</span>
          </label>
          {!inheritAllTools && (
            <div className="project-form__chips">
              {allTools.length === 0 && (
                <span className="project-form__hint">{t("dialog.agent.noToolsRegistered")}</span>
              )}
              {allTools.map((tool) => (
                <label key={tool} className="project-form__chip">
                  <input
                    type="checkbox"
                    checked={tools?.includes(tool) ?? false}
                    onChange={() =>
                      setTools((prev) => {
                        const list = prev ?? [];
                        return list.includes(tool)
                          ? list.filter((x) => x !== tool)
                          : [...list, tool];
                      })
                    }
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
          )}
        </label>

        <label className="project-form__field">
          <span>{t("dialog.agent.allowedSubagentsLabel")}</span>
          {subagentOptions.length === 0 ? (
            <span className="project-form__hint">{t("dialog.agent.noSubagentCandidates")}</span>
          ) : (
            <div className="project-form__chips">
              {subagentOptions.map((a) => (
                <label key={a.name} className="project-form__chip">
                  <input
                    type="checkbox"
                    checked={allowedSubagents.includes(a.name)}
                    onChange={() =>
                      toggle(allowedSubagents, setAllowedSubagents, a.name)
                    }
                  />
                  <span>@{a.name}</span>
                </label>
              ))}
            </div>
          )}
          <span className="project-form__hint">
            <Trans
              i18nKey="dialog.agent.subagentsHint"
              components={{ code: <code /> }}
            />
          </span>
        </label>

        <label className="project-form__field">
          <span>{t("dialog.agent.projectsLabel")}</span>
          {allProjects.length === 0 ? (
            <span className="project-form__hint">{t("dialog.agent.noProjectsAvailable")}</span>
          ) : (
            <div className="project-form__chips">
              {allProjects.map((p) => (
                <label key={p.name} className="project-form__chip">
                  <input
                    type="checkbox"
                    checked={linkedProjects.includes(p.name)}
                    onChange={() =>
                      toggle(linkedProjects, setLinkedProjects, p.name)
                    }
                  />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          )}
          <span className="project-form__hint">{t("dialog.agent.projectsHint")}</span>
        </label>

        <div className="project-form__row">
          <label className="project-form__field">
            <span>{t("dialog.agent.lastNLabel")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={lastN}
              onChange={(e) => setLastN(e.target.value)}
              placeholder={t("dialog.agent.lastNPlaceholder")}
            />
            <span className="project-form__hint">{t("dialog.agent.lastNHint")}</span>
          </label>
          <label className="project-form__field">
            <span>{t("dialog.agent.recallKLabel")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={recallK}
              onChange={(e) => setRecallK(e.target.value)}
              placeholder={t("dialog.agent.recallKPlaceholder")}
            />
            <span className="project-form__hint">{t("dialog.agent.recallKHint")}</span>
          </label>
        </div>

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
