import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { fetchProjectAgents, type Agent, type NewsTopic } from "../api";
import { X } from "../lib/icons";
import Modal from "./Modal";

type RenewMode = "never" | "always" | "scheduled";

export type TopicDialogValue = {
  name: string;
  description: string;
  agent: string;
  terms: string[];
  updateCron: string;
  renewTermsCron: string | null;
  alwaysRegenerateTerms: boolean;
  maxItemsPerRun: number;
  enabled: boolean;
};

type Props = {
  project: string;
  initial?: NewsTopic;
  onCancel: () => void;
  onSubmit: (value: TopicDialogValue) => void | Promise<void>;
};

const CRON_PRESETS: Array<{ key: "hourly" | "every6h" | "daily7" | "weeklyMon8"; value: string }> = [
  { key: "hourly", value: "0 * * * *" },
  { key: "every6h", value: "0 */6 * * *" },
  { key: "daily7", value: "0 7 * * *" },
  { key: "weeklyMon8", value: "0 8 * * 1" },
];

function presetLabel(
  key: (typeof CRON_PRESETS)[number]["key"],
  t: TFunction,
): string {
  switch (key) {
    case "hourly":
      return t("dialog.cronPresets.hourly");
    case "every6h":
      return t("dialog.cronPresets.every6h");
    case "daily7":
      return t("dialog.cronPresets.daily7");
    case "weeklyMon8":
      return t("dialog.cronPresets.weeklyMon8");
  }
}

function defaultFromInitial(initial?: NewsTopic): TopicDialogValue {
  if (initial) {
    return {
      name: initial.name,
      description: initial.description,
      agent: initial.agent,
      terms: [...initial.terms],
      updateCron: initial.updateCron,
      renewTermsCron: initial.renewTermsCron,
      alwaysRegenerateTerms: initial.alwaysRegenerateTerms,
      maxItemsPerRun: initial.maxItemsPerRun,
      enabled: initial.enabled,
    };
  }
  return {
    name: "",
    description: "",
    agent: "",
    terms: [],
    updateCron: "0 */6 * * *",
    renewTermsCron: null,
    alwaysRegenerateTerms: false,
    maxItemsPerRun: 10,
    enabled: true,
  };
}

function resolveRenewMode(initial?: NewsTopic): RenewMode {
  if (!initial) return "never";
  if (initial.alwaysRegenerateTerms) return "always";
  if (initial.renewTermsCron) return "scheduled";
  return "never";
}

export default function TopicDialog({
  project,
  initial,
  onCancel,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState<TopicDialogValue>(() =>
    defaultFromInitial(initial),
  );
  const [termsInput, setTermsInput] = useState("");
  const [renewMode, setRenewMode] = useState<RenewMode>(() =>
    resolveRenewMode(initial),
  );
  const [renewCronInput, setRenewCronInput] = useState<string>(
    initial?.renewTermsCron ?? "0 0 * * 0",
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetchProjectAgents(project)
      .then(setAgents)
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [project]);

  // When an already-chosen agent is not in the project list (just unlinked?),
  // synthesize an option so it still renders.
  const agentOptions = useMemo(() => {
    if (!value.agent) return agents;
    if (agents.some((a) => a.name === value.agent)) return agents;
    return [...agents, { name: value.agent } as Agent];
  }, [agents, value.agent]);

  const addTerm = () => {
    const trimmed = termsInput.trim();
    if (!trimmed) return;
    if (value.terms.includes(trimmed)) {
      setTermsInput("");
      return;
    }
    setValue({ ...value, terms: [...value.terms, trimmed] });
    setTermsInput("");
  };

  const removeTerm = (t: string) => {
    setValue({ ...value, terms: value.terms.filter((x) => x !== t) });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.name.trim()) return setError(t("dialog.topic.errNameRequired"));
    if (!value.agent) return setError(t("dialog.topic.errAgentRequired"));
    if (!value.updateCron.trim()) return setError(t("dialog.topic.errUpdateCronRequired"));

    const payload: TopicDialogValue = {
      ...value,
      alwaysRegenerateTerms: renewMode === "always",
      renewTermsCron:
        renewMode === "scheduled" ? renewCronInput.trim() || null : null,
    };
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onCancel} size="md">
      <form onSubmit={handleSubmit}>
        <Modal.Header
          title={initial ? t("dialog.topic.titleEdit") : t("dialog.topic.titleCreate")}
        />

        <div className="modal__body">
          <label className="field">
            <span className="field__label">{t("dialog.topic.nameLabel")}</span>
            <input
              className="field__input"
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              placeholder={t("dialog.topic.namePlaceholder")}
              required
            />
          </label>

          <label className="field">
            <span className="field__label">{t("dialog.topic.descriptionLabel")}</span>
            <textarea
              className="field__input"
              rows={2}
              value={value.description}
              onChange={(e) =>
                setValue({ ...value, description: e.target.value })
              }
              placeholder={t("dialog.topic.descriptionPlaceholder")}
            />
          </label>

          <label className="field">
            <span className="field__label">{t("dialog.topic.agentLabel")}</span>
            <select
              className="field__input"
              value={value.agent}
              onChange={(e) => setValue({ ...value, agent: e.target.value })}
              required
            >
              <option value="">{t("dialog.topic.agentSelect")}</option>
              {agentOptions.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <span className="field__hint">{t("dialog.topic.agentHint")}</span>
          </label>

          <div className="field">
            <span className="field__label">{t("dialog.topic.termsLabel")}</span>
            <div className="field__chips">
              {value.terms.map((term) => (
                <span key={term} className="chip">
                  {term}
                  <button
                    type="button"
                    className="chip__remove"
                    onClick={() => removeTerm(term)}
                    aria-label={t("dialog.topic.removeTermAria", { term })}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="field__row">
              <input
                className="field__input"
                value={termsInput}
                onChange={(e) => setTermsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTerm();
                  }
                }}
                placeholder={t("dialog.topic.termInputPlaceholder")}
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={addTerm}
              >
                {t("dialog.topic.addTerm")}
              </button>
            </div>
            <span className="field__hint">{t("dialog.topic.termsHint")}</span>
          </div>

          <label className="field">
            <span className="field__label">{t("dialog.topic.updateCronLabel")}</span>
            <input
              className="field__input"
              value={value.updateCron}
              onChange={(e) =>
                setValue({ ...value, updateCron: e.target.value })
              }
              required
            />
            <div className="field__presets">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className="btn btn--ghost btn--xs"
                  onClick={() => setValue({ ...value, updateCron: p.value })}
                >
                  {presetLabel(p.key, t)}
                </button>
              ))}
            </div>
          </label>

          <div className="field">
            <span className="field__label">{t("dialog.topic.renewLabel")}</span>
            <div className="field__radios">
              <label>
                <input
                  type="radio"
                  name="renew-mode"
                  checked={renewMode === "never"}
                  onChange={() => setRenewMode("never")}
                />
                {t("dialog.topic.renewNever")}
              </label>
              <label>
                <input
                  type="radio"
                  name="renew-mode"
                  checked={renewMode === "always"}
                  onChange={() => setRenewMode("always")}
                />
                {t("dialog.topic.renewAlways")}
              </label>
              <label>
                <input
                  type="radio"
                  name="renew-mode"
                  checked={renewMode === "scheduled"}
                  onChange={() => setRenewMode("scheduled")}
                />
                {t("dialog.topic.renewScheduled")}
              </label>
            </div>
            {renewMode === "scheduled" && (
              <input
                className="field__input"
                value={renewCronInput}
                onChange={(e) => setRenewCronInput(e.target.value)}
                placeholder="0 0 * * 0"
              />
            )}
          </div>

          <label className="field">
            <span className="field__label">
              {t("dialog.topic.maxItemsLabel", { count: value.maxItemsPerRun })}
            </span>
            <input
              type="range"
              min={1}
              max={30}
              value={value.maxItemsPerRun}
              onChange={(e) =>
                setValue({ ...value, maxItemsPerRun: Number(e.target.value) })
              }
            />
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) =>
                setValue({ ...value, enabled: e.target.checked })
              }
            />
            <span>{t("dialog.topic.enabledLabel")}</span>
          </label>

          {error && <div className="modal__error">{error}</div>}
        </div>

        <Modal.Footer>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn--send" disabled={submitting}>
            {submitting
              ? t("common.saving")
              : initial
                ? t("common.save")
                : t("common.create")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
