import { useEffect, useMemo, useState } from "react";
import { fetchProjectAgents, type Agent, type NewsTopic } from "../api";
import { X } from "../lib/icons";

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

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily 07:00", value: "0 7 * * *" },
  { label: "Weekly Mon 08:00", value: "0 8 * * 1" },
];

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
    void fetchProjectAgents(project).then(setAgents).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [project]);

  // When an already-chosen agent is not in the project list (just unlinked?),
  // synthesize an option so it still renders.
  const agentOptions = useMemo(() => {
    if (!value.agent) return agents;
    if (agents.some((a) => a.name === value.agent)) return agents;
    return [
      ...agents,
      { name: value.agent } as Agent,
    ];
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
    if (!value.name.trim()) return setError("Name is required");
    if (!value.agent) return setError("Agent is required");
    if (!value.updateCron.trim()) return setError("Update cron is required");

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
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="modal__header">
          <h2>{initial ? "Edit news topic" : "New news topic"}</h2>
          <button
            type="button"
            className="modal__close"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="modal__body">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="field__input"
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              placeholder="AI industry news"
              required
            />
          </label>

          <label className="field">
            <span className="field__label">Description</span>
            <textarea
              className="field__input"
              rows={2}
              value={value.description}
              onChange={(e) =>
                setValue({ ...value, description: e.target.value })
              }
              placeholder="What this topic is about (helps the agent focus)"
            />
          </label>

          <label className="field">
            <span className="field__label">Agent</span>
            <select
              className="field__input"
              value={value.agent}
              onChange={(e) => setValue({ ...value, agent: e.target.value })}
              required
            >
              <option value="">Select an agent…</option>
              {agentOptions.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <span className="field__hint">
              Only agents linked to this project are listed.
            </span>
          </label>

          <div className="field">
            <span className="field__label">Search terms</span>
            <div className="field__chips">
              {value.terms.map((t) => (
                <span key={t} className="chip">
                  {t}
                  <button
                    type="button"
                    className="chip__remove"
                    onClick={() => removeTerm(t)}
                    aria-label={`Remove ${t}`}
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
                placeholder="Add a term and press Enter"
              />
              <button type="button" className="btn btn--secondary" onClick={addTerm}>
                Add
              </button>
            </div>
            <span className="field__hint">
              Leave empty to let the agent propose terms on the first run.
            </span>
          </div>

          <label className="field">
            <span className="field__label">Update schedule (cron)</span>
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
                  {p.label}
                </button>
              ))}
            </div>
          </label>

          <div className="field">
            <span className="field__label">Renew terms</span>
            <div className="field__radios">
              <label>
                <input
                  type="radio"
                  name="renew-mode"
                  checked={renewMode === "never"}
                  onChange={() => setRenewMode("never")}
                />
                Never
              </label>
              <label>
                <input
                  type="radio"
                  name="renew-mode"
                  checked={renewMode === "always"}
                  onChange={() => setRenewMode("always")}
                />
                Regenerate every run
              </label>
              <label>
                <input
                  type="radio"
                  name="renew-mode"
                  checked={renewMode === "scheduled"}
                  onChange={() => setRenewMode("scheduled")}
                />
                Scheduled
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
              Max items per run: {value.maxItemsPerRun}
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
              onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
            />
            <span>Enabled (scheduler will run this topic)</span>
          </label>

          {error && <div className="modal__error">{error}</div>}
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? "Saving…" : initial ? "Save" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
