import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentContextScope, AgentVisibility, Project } from "../api";
import { AGENT_NAME_RE } from "../../../src/memory/agent_name";
import { validateOverride } from "../lib/forms";

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
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [appendMode, setAppendMode] = useState(initial?.appendMode ?? false);
  const [visibility, setVisibility] = useState<AgentVisibility>(initial?.visibility ?? "private");
  const [contextScope, setContextScope] = useState<AgentContextScope>(
    initial?.contextScope ?? "full",
  );
  const [knowsOtherAgents, setKnowsOtherAgents] = useState(initial?.knowsOtherAgents ?? false);
  const [isSubagent, setIsSubagent] = useState(initial?.isSubagent ?? false);
  // `null` means "inherit every registered tool"; an array is the whitelist.
  const [tools, setTools] = useState<string[] | null>(initial?.tools ?? null);
  const inheritAllTools = tools === null;
  const [allowedSubagents, setAllowedSubagents] = useState<string[]>(
    initial?.allowedSubagents ?? [],
  );
  const [linkedProjects, setLinkedProjects] = useState<string[]>(initial?.projects ?? []);
  const [lastN, setLastN] = useState(initial?.lastN == null ? "" : String(initial.lastN));
  const [recallK, setRecallK] = useState(initial?.recallK == null ? "" : String(initial.recallK));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "create") nameRef.current?.focus();
  }, [mode]);

  const nameValid = mode === "edit" || AGENT_NAME_RE.test(name.trim().toLowerCase());

  const subagentOptions = useMemo(
    () => subagentCandidates.filter((a) => a.isSubagent && a.name !== initial?.name),
    [subagentCandidates, initial?.name],
  );

  const toggle = (list: string[], set: (v: string[]) => void, item: string) => {
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid) {
      setError("Name must be lowercase letters, digits, _ or - (max 63 chars).");
      return;
    }
    const parsedLastN = validateOverride(lastN);
    const parsedRecallK = validateOverride(recallK);
    if (parsedLastN === undefined || parsedRecallK === undefined) {
      setError("Memory overrides must be blank or a non-negative integer.");
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="project-form">
          <h2>{mode === "create" ? "New agent" : `Edit ${initial?.name}`}</h2>

          <label className="project-form__field">
            <span>Name</span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              disabled={mode === "edit"}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. researcher, code-reviewer"
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
            <span>Description</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this agent do? Shown in @-mention hints."
            />
          </label>

          <label className="project-form__field">
            <span>System prompt</span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              placeholder="The agent's identity and instructions."
            />
          </label>

          <div className="project-form__row">
            <label className="project-form__choice">
              <input
                type="checkbox"
                checked={appendMode}
                onChange={(e) => setAppendMode(e.target.checked)}
              />
              <span>Append to base prompt (uncheck to fully replace)</span>
            </label>
            <label className="project-form__choice">
              <span>Visibility</span>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as AgentVisibility)}
              >
                <option value="private">Private (only you)</option>
                <option value="public">Public</option>
              </select>
            </label>
          </div>

          <div className="project-form__row">
            <label className="project-form__choice">
              <span>Context scope</span>
              <select
                value={contextScope}
                onChange={(e) => setContextScope(e.target.value as AgentContextScope)}
              >
                <option value="full">Full — sees the whole session</option>
                <option value="own">Own — only sees its own prior turns</option>
              </select>
            </label>
            <label className="project-form__choice">
              <input
                type="checkbox"
                checked={knowsOtherAgents}
                onChange={(e) => setKnowsOtherAgents(e.target.checked)}
              />
              <span>Aware of other agents (injected into the prompt)</span>
            </label>
          </div>

          <div className="project-form__row">
            <label className="project-form__choice">
              <input
                type="checkbox"
                checked={isSubagent}
                onChange={(e) => setIsSubagent(e.target.checked)}
              />
              <span>Can be called as a subagent (via <code>call_agent</code>)</span>
            </label>
          </div>

          <label className="project-form__field">
            <span>Tools</span>
            <label className="project-form__choice">
              <input
                type="checkbox"
                checked={inheritAllTools}
                onChange={(e) => setTools(e.target.checked ? null : [])}
              />
              <span>Inherit every registered tool</span>
            </label>
            {!inheritAllTools && (
              <div className="project-form__chips">
                {allTools.length === 0 && (
                  <span className="project-form__hint">No tools registered.</span>
                )}
                {allTools.map((t) => (
                  <label key={t} className="project-form__chip">
                    <input
                      type="checkbox"
                      checked={tools?.includes(t) ?? false}
                      onChange={() =>
                        setTools((prev) => {
                          const list = prev ?? [];
                          return list.includes(t) ? list.filter((x) => x !== t) : [...list, t];
                        })
                      }
                    />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
            )}
          </label>

          <label className="project-form__field">
            <span>Allowed subagents</span>
            {subagentOptions.length === 0 ? (
              <span className="project-form__hint">
                No other agents are marked as subagent-callable yet.
              </span>
            ) : (
              <div className="project-form__chips">
                {subagentOptions.map((a) => (
                  <label key={a.name} className="project-form__chip">
                    <input
                      type="checkbox"
                      checked={allowedSubagents.includes(a.name)}
                      onChange={() => toggle(allowedSubagents, setAllowedSubagents, a.name)}
                    />
                    <span>@{a.name}</span>
                  </label>
                ))}
              </div>
            )}
            <span className="project-form__hint">
              When non-empty, this agent gains the <code>call_agent</code> tool.
            </span>
          </label>

          <label className="project-form__field">
            <span>Projects</span>
            {allProjects.length === 0 ? (
              <span className="project-form__hint">No projects available.</span>
            ) : (
              <div className="project-form__chips">
                {allProjects.map((p) => (
                  <label key={p.name} className="project-form__chip">
                    <input
                      type="checkbox"
                      checked={linkedProjects.includes(p.name)}
                      onChange={() => toggle(linkedProjects, setLinkedProjects, p.name)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            )}
            <span className="project-form__hint">
              Which projects this agent is available in.
            </span>
          </label>

          <div className="project-form__row">
            <label className="project-form__field">
              <span>Last N turns</span>
              <input
                type="number"
                min={0}
                step={1}
                value={lastN}
                onChange={(e) => setLastN(e.target.value)}
                placeholder="inherit"
              />
              <span className="project-form__hint">
                Blank = inherit project / global. Set low (e.g. 0–2) for one-shot specialists.
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
                placeholder="inherit"
              />
              <span className="project-form__hint">
                Blank = inherit. 0 disables recall entirely for this agent.
              </span>
            </label>
          </div>

          {error && <div className="project-form__error">{error}</div>}

          <div className="project-form__actions">
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--send" disabled={submitting || !nameValid}>
              {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

