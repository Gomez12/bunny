import { useEffect, useMemo, useState } from "react";
import type {
  ClientWorkflowDef,
  ClientWorkflowNode,
  NodeKind,
} from "../../lib/workflowParser";
import { fetchProjectAgents, type Agent } from "../../api";
import { Trash2, X } from "../../lib/icons";

interface Props {
  def: ClientWorkflowDef;
  nodeId: string;
  project: string;
  onClose: () => void;
  onChange: (next: ClientWorkflowDef) => void;
  onDelete: (nodeId: string) => void;
}

/**
 * Right-side drawer with kind-specific fields for the selected node.
 *
 * The node itself is not held locally — we derive it from `def` on every
 * render so external TOML edits flow in cleanly. Field edits produce a
 * fresh `ClientWorkflowDef` and call `onChange`; the parent reserializes
 * to TOML and saves.
 */
export default function NodeEditDrawer({
  def,
  nodeId,
  project,
  onClose,
  onChange,
  onDelete,
}: Props) {
  const node = def.nodes.find((n) => n.id === nodeId);
  const [idDraft, setIdDraft] = useState<string>(nodeId);
  const [idError, setIdError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);

  useEffect(() => {
    setIdDraft(nodeId);
    setIdError(null);
  }, [nodeId]);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectAgents(project)
      .then((rows) => {
        if (!cancelled) setAgents(rows);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Guarantee the selected agent stays visible in the dropdown even if it's
  // been unlinked from the project since this node was authored.
  const agentOptions = useMemo(() => {
    const names = new Set<string>();
    for (const a of agents ?? []) names.add(a.name);
    const currentAgent = node?.agent?.trim();
    if (currentAgent) names.add(currentAgent);
    return Array.from(names).sort();
  }, [agents, node?.agent]);

  if (!node) {
    return (
      <aside className="wf-drawer">
        <div className="wf-drawer__head">
          <strong>Node not found</strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close drawer">
            <X size={14} />
          </button>
        </div>
      </aside>
    );
  }

  const patchNode = (mutate: (n: ClientWorkflowNode) => ClientWorkflowNode) => {
    onChange({
      ...def,
      nodes: def.nodes.map((n) => (n.id === node.id ? mutate(n) : n)),
    });
  };

  const commitId = () => {
    const next = idDraft.trim().toLowerCase();
    if (next === node.id) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(next)) {
      setIdError("lowercase letters, digits, _ and - only; must start with a letter or digit");
      return;
    }
    if (def.nodes.some((n) => n.id === next)) {
      setIdError(`another node already uses '${next}'`);
      return;
    }
    setIdError(null);
    // Rename: update the node's own id AND rewrite every depends_on that
    // points at the old id. Edges in the graph follow automatically because
    // edges are derived from depends_on.
    onChange({
      ...def,
      nodes: def.nodes.map((n) => {
        if (n.id === node.id) return { ...n, id: next };
        if (n.depends_on.includes(node.id)) {
          return {
            ...n,
            depends_on: n.depends_on.map((d) => (d === node.id ? next : d)),
          };
        }
        return n;
      }),
    });
  };

  const changeKind = (k: NodeKind) => {
    if (k === node.kind) return;
    patchNode((n) => {
      const base: ClientWorkflowNode = {
        id: n.id,
        depends_on: n.depends_on,
        kind: k,
      };
      if (n.agent) base.agent = n.agent;
      if (n.timeout_ms !== undefined) base.timeout_ms = n.timeout_ms;
      switch (k) {
        case "prompt":
          base.prompt = n.prompt ?? "Describe the task here.";
          break;
        case "bash":
          base.bash = n.bash ?? "echo hello";
          break;
        case "script":
          base.script =
            n.script ??
            "// TypeScript runs via `bun -e`\nconsole.log('hello from script');";
          break;
        case "loop":
          base.loop = n.loop ?? {
            prompt: "Iterate on the task; stop when done.",
            until: "ALL_TASKS_COMPLETE",
            fresh_context: false,
          };
          break;
        case "for_each":
          base.for_each = n.for_each ?? {
            count: "{{nodes.some_upstream.output}}",
            body: [],
            item_var: "item",
            index_var: "iteration",
          };
          break;
        case "if_then_else":
          base.if_then_else = n.if_then_else ?? {
            condition: "{{nodes.some_upstream.output}}",
            then_body: [],
            else_body: [],
          };
          break;
        case "interactive":
          base.interactive = true;
          break;
      }
      return base;
    });
  };

  const bodyCandidates = def.nodes
    .filter((n) => n.id !== node.id)
    .map((n) => n.id);

  return (
    <aside className="wf-drawer" aria-label="Edit node">
      <div className="wf-drawer__head">
        <strong>Edit node</strong>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            className="icon-btn"
            title="Delete node"
            aria-label="Delete node"
            onClick={() => onDelete(node.id)}
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="wf-drawer__body">
        <FieldRow label="Id">
          <input
            type="text"
            className="input"
            value={idDraft}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={commitId}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          {idError ? <div className="wf-drawer__hint wf-drawer__hint--error">{idError}</div> : null}
        </FieldRow>

        <FieldRow label="Kind">
          <div className="wf-drawer__kind-picker" role="group">
            {(
              [
                "prompt",
                "bash",
                "script",
                "loop",
                "for_each",
                "if_then_else",
                "interactive",
              ] as NodeKind[]
            ).map((k) => (
              <button
                key={k}
                type="button"
                className={`btn btn--sm ${k === node.kind ? "btn--primary" : ""}`}
                onClick={() => changeKind(k)}
              >
                {k.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </FieldRow>

        {node.depends_on.length > 0 ? (
          <FieldRow label="Depends on">
            <div className="wf-drawer__deps">
              {node.depends_on.map((d) => (
                <span key={d} className="wf-drawer__dep">
                  {d}
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Remove dependency on ${d}`}
                    aria-label={`Remove dependency on ${d}`}
                    onClick={() =>
                      patchNode((n) => ({
                        ...n,
                        depends_on: n.depends_on.filter((x) => x !== d),
                      }))
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="wf-drawer__hint">
              Drag from another node's bottom handle to this node's top handle
              to add a dependency.
            </div>
          </FieldRow>
        ) : (
          <FieldRow label="Depends on">
            <div className="wf-drawer__hint">
              None — this node runs first in its branch. Drag an edge from
              another node's bottom handle to add a dependency.
            </div>
          </FieldRow>
        )}

        {node.kind === "prompt" && (
          <FieldRow label="Prompt">
            <textarea
              className="wf-drawer__textarea"
              value={node.prompt ?? ""}
              onChange={(e) => patchNode((n) => ({ ...n, prompt: e.target.value }))}
              rows={6}
            />
          </FieldRow>
        )}
        {node.kind === "bash" && (
          <FieldRow label="Command">
            <textarea
              className="wf-drawer__textarea wf-drawer__textarea--mono"
              value={node.bash ?? ""}
              onChange={(e) => patchNode((n) => ({ ...n, bash: e.target.value }))}
              rows={4}
            />
            <div className="wf-drawer__hint">
              Runs in the project's workspace directory. The first execution
              per node requires operator approval via the ask-user dialog.
            </div>
          </FieldRow>
        )}
        {node.kind === "script" && (
          <FieldRow label="Code">
            <textarea
              className="wf-drawer__textarea wf-drawer__textarea--mono"
              value={node.script ?? ""}
              onChange={(e) =>
                patchNode((n) => ({ ...n, script: e.target.value }))
              }
              rows={10}
              spellCheck={false}
            />
            <div className="wf-drawer__hint">
              Executed as <code>bun -e &lt;code&gt;</code> in a child process,
              with the project workspace as cwd. Supports top-level{" "}
              <code>await</code>, imports, and all Bun APIs. Same approval +
              timeout + output-cap gates as Bash. Use{" "}
              <code>console.log(…)</code> to capture output.
            </div>
          </FieldRow>
        )}
        {node.kind === "loop" && (
          <>
            <FieldRow label="Loop prompt">
              <textarea
                className="wf-drawer__textarea"
                value={node.loop?.prompt ?? ""}
                onChange={(e) =>
                  patchNode((n) => ({
                    ...n,
                    loop: {
                      ...(n.loop ?? {
                        prompt: "",
                        until: "ALL_TASKS_COMPLETE",
                      }),
                      prompt: e.target.value,
                    },
                  }))
                }
                rows={5}
              />
            </FieldRow>
            <FieldRow label="Stop condition (until)">
              <input
                type="text"
                className="input"
                value={node.loop?.until ?? ""}
                onChange={(e) =>
                  patchNode((n) => ({
                    ...n,
                    loop: {
                      ...(n.loop ?? { prompt: "" }),
                      prompt: n.loop?.prompt ?? "",
                      until: e.target.value,
                    },
                  }))
                }
              />
              <div className="wf-drawer__hint">
                The engine appends a "finish by writing <code>{"<<<" + (node.loop?.until || "STOP") + ">>>"}</code>"
                instruction and loops until it sees the token in the final answer.
              </div>
            </FieldRow>
            <FieldRow label="Options">
              <label className="wf-drawer__check">
                <input
                  type="checkbox"
                  checked={node.loop?.fresh_context === true}
                  onChange={(e) =>
                    patchNode((n) => ({
                      ...n,
                      loop: {
                        ...(n.loop ?? { prompt: "", until: "ALL_TASKS_COMPLETE" }),
                        prompt: n.loop?.prompt ?? "",
                        until: n.loop?.until ?? "ALL_TASKS_COMPLETE",
                        fresh_context: e.target.checked,
                      },
                    }))
                  }
                />
                Fresh context each iteration
              </label>
              <label className="wf-drawer__check">
                <input
                  type="checkbox"
                  checked={node.loop?.interactive === true}
                  onChange={(e) =>
                    patchNode((n) => ({
                      ...n,
                      loop: {
                        ...(n.loop ?? { prompt: "", until: "ALL_TASKS_COMPLETE" }),
                        prompt: n.loop?.prompt ?? "",
                        until: n.loop?.until ?? "ALL_TASKS_COMPLETE",
                        interactive: e.target.checked,
                      },
                    }))
                  }
                />
                Allow the agent to call <code>ask_user</code> per iteration
              </label>
            </FieldRow>
            <FieldRow label="Max iterations">
              <input
                type="number"
                min={1}
                max={100}
                className="input"
                value={node.loop?.max_iterations ?? ""}
                placeholder="10"
                onChange={(e) => {
                  const n2 = e.target.value === "" ? undefined : Number(e.target.value);
                  patchNode((n) => ({
                    ...n,
                    loop: {
                      ...(n.loop ?? { prompt: "", until: "ALL_TASKS_COMPLETE" }),
                      prompt: n.loop?.prompt ?? "",
                      until: n.loop?.until ?? "ALL_TASKS_COMPLETE",
                      max_iterations: n2,
                    },
                  }));
                }}
              />
            </FieldRow>
          </>
        )}
        {node.kind === "for_each" && (
          <>
            <FieldRow label="Source">
              <div className="wf-drawer__kind-picker" role="group">
                <button
                  type="button"
                  className={`btn btn--sm ${node.for_each?.count !== undefined ? "btn--primary" : ""}`}
                  onClick={() =>
                    patchNode((n) => ({
                      ...n,
                      for_each: {
                        ...(n.for_each ?? { body: [] }),
                        count:
                          n.for_each?.count ??
                          "{{nodes.some_upstream.output}}",
                        items: undefined,
                      },
                    }))
                  }
                >
                  count
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${node.for_each?.items !== undefined ? "btn--primary" : ""}`}
                  onClick={() =>
                    patchNode((n) => ({
                      ...n,
                      for_each: {
                        ...(n.for_each ?? { body: [] }),
                        items:
                          n.for_each?.items ??
                          "{{nodes.some_upstream.output}}",
                        count: undefined,
                      },
                    }))
                  }
                >
                  items
                </button>
              </div>
              <div className="wf-drawer__hint">
                <strong>count</strong> = iterate N times (1..N). Useful when
                an upstream agent produced a number of rows.
                <br />
                <strong>items</strong> = iterate over a list. The engine
                tries to parse the value as a JSON array; falls back to
                splitting on newlines.
              </div>
            </FieldRow>
            {node.for_each?.count !== undefined && (
              <FieldRow label="Count expression">
                <textarea
                  className="wf-drawer__textarea wf-drawer__textarea--mono"
                  value={node.for_each?.count ?? ""}
                  onChange={(e) =>
                    patchNode((n) => ({
                      ...n,
                      for_each: {
                        ...(n.for_each ?? { body: [] }),
                        count: e.target.value,
                      },
                    }))
                  }
                  rows={2}
                />
                <div className="wf-drawer__hint">
                  Tip: <code>{"{{nodes.count_rows.output}}"}</code> uses the
                  output of another node.
                </div>
              </FieldRow>
            )}
            {node.for_each?.items !== undefined && (
              <FieldRow label="Items expression">
                <textarea
                  className="wf-drawer__textarea wf-drawer__textarea--mono"
                  value={node.for_each?.items ?? ""}
                  onChange={(e) =>
                    patchNode((n) => ({
                      ...n,
                      for_each: {
                        ...(n.for_each ?? { body: [] }),
                        items: e.target.value,
                      },
                    }))
                  }
                  rows={2}
                />
                <div className="wf-drawer__hint">
                  Tip: <code>{"{{nodes.list_files.output}}"}</code> — expect
                  the other node to end its answer with a JSON array, or
                  newline-separated values.
                </div>
              </FieldRow>
            )}
            <FieldRow label="Body (runs once per iteration)">
              <BodyEditor
                value={node.for_each?.body ?? []}
                candidates={bodyCandidates}
                onChange={(body) =>
                  patchNode((n) => ({
                    ...n,
                    for_each: { ...(n.for_each ?? { body: [] }), body },
                  }))
                }
              />
            </FieldRow>
            <FieldRow label="Variable names">
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  className="input"
                  placeholder="item"
                  value={node.for_each?.item_var ?? ""}
                  onChange={(e) =>
                    patchNode((n) => ({
                      ...n,
                      for_each: {
                        ...(n.for_each ?? { body: [] }),
                        item_var: e.target.value.trim() || undefined,
                      },
                    }))
                  }
                  style={{ flex: 1 }}
                />
                <input
                  type="text"
                  className="input"
                  placeholder="iteration"
                  value={node.for_each?.index_var ?? ""}
                  onChange={(e) =>
                    patchNode((n) => ({
                      ...n,
                      for_each: {
                        ...(n.for_each ?? { body: [] }),
                        index_var: e.target.value.trim() || undefined,
                      },
                    }))
                  }
                  style={{ flex: 1 }}
                />
              </div>
              <div className="wf-drawer__hint">
                Body nodes can use <code>{"{{item}}"}</code> and{" "}
                <code>{"{{iteration}}"}</code> in their prompt / bash fields.
              </div>
            </FieldRow>
          </>
        )}
        {node.kind === "if_then_else" && (
          <>
            <FieldRow label="Condition">
              <textarea
                className="wf-drawer__textarea wf-drawer__textarea--mono"
                value={node.if_then_else?.condition ?? ""}
                onChange={(e) =>
                  patchNode((n) => ({
                    ...n,
                    if_then_else: {
                      ...(n.if_then_else ?? {
                        then_body: [],
                        else_body: [],
                        condition: "",
                      }),
                      condition: e.target.value,
                    },
                  }))
                }
                rows={2}
              />
              <div className="wf-drawer__hint">
                After interpolation the value is trimmed. Empty / "0" /
                "false" / "no" / "null" → else-branch; anything else →
                then-branch.
              </div>
            </FieldRow>
            <FieldRow label="Then body">
              <BodyEditor
                value={node.if_then_else?.then_body ?? []}
                candidates={bodyCandidates}
                onChange={(then_body) =>
                  patchNode((n) => ({
                    ...n,
                    if_then_else: {
                      ...(n.if_then_else ?? {
                        condition: "",
                        then_body: [],
                        else_body: [],
                      }),
                      then_body,
                    },
                  }))
                }
              />
            </FieldRow>
            <FieldRow label="Else body">
              <BodyEditor
                value={node.if_then_else?.else_body ?? []}
                candidates={bodyCandidates}
                onChange={(else_body) =>
                  patchNode((n) => ({
                    ...n,
                    if_then_else: {
                      ...(n.if_then_else ?? {
                        condition: "",
                        then_body: [],
                        else_body: [],
                      }),
                      else_body,
                    },
                  }))
                }
              />
            </FieldRow>
          </>
        )}
        {node.kind === "interactive" && (
          <FieldRow label="Behaviour">
            <div className="wf-drawer__hint">
              Pauses the run and shows the operator an Approve/Reject dialog.
              The node completes when the operator answers.
            </div>
          </FieldRow>
        )}

        <FieldRow label="Agent (optional)">
          <select
            className="input"
            value={node.agent ?? ""}
            onChange={(e) =>
              patchNode((n) => ({
                ...n,
                agent: e.target.value.trim() || undefined,
              }))
            }
          >
            <option value="">(project default)</option>
            {agentOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {agents === null ? (
            <div className="wf-drawer__hint">Loading agents…</div>
          ) : agentOptions.length === 0 ? (
            <div className="wf-drawer__hint">
              No agents linked to this project yet. Link one from the
              Workspace tab first.
            </div>
          ) : null}
        </FieldRow>
      </div>
    </aside>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="wf-drawer__field">
      <label className="wf-drawer__label">{label}</label>
      {children}
    </div>
  );
}

/**
 * Compact body-id editor: shows picked ids as chips + a dropdown that
 * offers remaining candidates. Each candidate may only be in one body at
 * a time — the parser enforces that on save, so the caller is responsible
 * for not offering already-owned ids.
 */
function BodyEditor({
  value,
  candidates,
  onChange,
}: {
  value: string[];
  candidates: string[];
  onChange: (next: string[]) => void;
}) {
  const remaining = candidates.filter((id) => !value.includes(id));
  return (
    <div>
      <div className="wf-drawer__deps">
        {value.length === 0 ? (
          <span className="wf-drawer__hint">(empty — pick a node below)</span>
        ) : null}
        {value.map((id) => (
          <span key={id} className="wf-drawer__dep">
            {id}
            <button
              type="button"
              className="icon-btn"
              title={`Remove ${id}`}
              aria-label={`Remove ${id}`}
              onClick={() => onChange(value.filter((v) => v !== id))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      {remaining.length > 0 ? (
        <select
          className="input"
          value=""
          onChange={(e) => {
            const pick = e.target.value;
            if (!pick) return;
            onChange([...value, pick]);
          }}
          style={{ marginTop: 6 }}
        >
          <option value="">+ add node…</option>
          {remaining.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
