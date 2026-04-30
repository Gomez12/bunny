import { useEffect, useState } from "react";
import type {
  AgentProjectMemoryInfo,
  AuthUser,
  ProjectMemoryInfo,
} from "../api";
import {
  fetchAgentProjectMemory,
  fetchOwnProjectMemory,
  fetchProjectAgents,
  updateAgentProjectMemory,
  updateOwnProjectMemory,
} from "../api";

type Props = {
  currentUser: AuthUser;
  activeProject: string;
};

interface AgentEntry {
  name: string;
  description: string;
  memory: AgentProjectMemoryInfo | null;
  loadError: string | null;
}

export default function MemoryPanel({ currentUser, activeProject }: Props) {
  const [own, setOwn] = useState<
    (ProjectMemoryInfo & { userId: string }) | null
  >(null);
  const [ownDraft, setOwnDraft] = useState("");
  const [agents, setAgents] = useState<AgentEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setOwn(null);
    setAgents(null);
    void (async () => {
      try {
        const mine = await fetchOwnProjectMemory(activeProject);
        if (cancelled) return;
        setOwn(mine);
        setOwnDraft(mine.memory);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not load memory");
      }
      try {
        const projectAgents = await fetchProjectAgents(activeProject);
        const entries: AgentEntry[] = await Promise.all(
          projectAgents.map(async (a) => {
            try {
              const m = await fetchAgentProjectMemory(activeProject, a.name);
              return {
                name: a.name,
                description: a.description,
                memory: m,
                loadError: null,
              };
            } catch (e) {
              return {
                name: a.name,
                description: a.description,
                memory: null,
                loadError: e instanceof Error ? e.message : "load failed",
              };
            }
          }),
        );
        if (!cancelled) setAgents(entries);
      } catch (e) {
        if (!cancelled)
          setAgents([]);
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not load agents");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProject]);

  return (
    <div className="memory-panel">
      <header>
        <h2>Memory · {activeProject}</h2>
        <p>
          Compact, auto-curated facts the system has learned about you and
          each agent in this project. Refreshed hourly from your messages;
          edit freely — your text becomes the seed for the next refresh.
        </p>
        {err && <div className="auth-error">{err}</div>}
      </header>

      <section>
        <h3>My memory in this project</h3>
        {own ? (
          <OwnMemoryEditor
            project={activeProject}
            info={own}
            draft={ownDraft}
            setDraft={setOwnDraft}
            setInfo={setOwn}
          />
        ) : (
          <div className="app-loading">Loading…</div>
        )}
      </section>

      <section>
        <h3>Agent memory</h3>
        {agents == null ? (
          <div className="app-loading">Loading…</div>
        ) : agents.length === 0 ? (
          <p className="muted">No agents linked to this project.</p>
        ) : (
          <ul>
            {agents.map((a) => (
              <li key={a.name}>
                <AgentMemoryEditor
                  project={activeProject}
                  agentName={a.name}
                  agentDescription={a.description}
                  initial={a.memory}
                  loadError={a.loadError}
                  canEdit={currentUser.role === "admin"}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function statusLabel(
  info: { status: string; refreshedAt: number | null } | null,
): string {
  if (!info) return "—";
  const ts = info.refreshedAt
    ? new Date(info.refreshedAt).toLocaleString()
    : "never";
  return `${info.status} · last refreshed ${ts}`;
}

function OwnMemoryEditor(props: {
  project: string;
  info: ProjectMemoryInfo & { userId: string };
  draft: string;
  setDraft: (v: string) => void;
  setInfo: (v: ProjectMemoryInfo & { userId: string }) => void;
}) {
  const { project, info, draft, setDraft, setInfo } = props;
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cap = info.maxChars;
  const dirty = draft !== info.memory;

  const save = async () => {
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      const next = await updateOwnProjectMemory(project, draft);
      setInfo(next);
      setDraft(next.memory);
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, cap))}
        rows={8}
        placeholder={
          info.memory
            ? ""
            : "Empty for now — the hourly memory.refresh handler will fill this in once new messages arrive."
        }
      />
      <div className="memory-panel__meta">
        <span>
          {draft.length} / {cap}
        </span>
        <span>{statusLabel(info)}</span>
      </div>
      <button type="button" onClick={save} disabled={saving || !dirty}>
        {saving ? "Saving…" : "Save my memory"}
      </button>
      {msg && <div className="auth-ok">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}
    </div>
  );
}

function AgentMemoryEditor(props: {
  project: string;
  agentName: string;
  agentDescription: string;
  initial: AgentProjectMemoryInfo | null;
  loadError: string | null;
  canEdit: boolean;
}) {
  const { project, agentName, agentDescription, initial, loadError, canEdit } =
    props;
  const [info, setInfo] = useState<AgentProjectMemoryInfo | null>(initial);
  const [draft, setDraft] = useState(initial?.memory ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const cap = info?.maxChars ?? 4000;
  const dirty = info != null && draft !== info.memory;

  const save = async () => {
    if (!info) return;
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      const next = await updateAgentProjectMemory(project, agentName, draft);
      setInfo(next);
      setDraft(next.memory);
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <header className="memory-panel__agent-header">
        <strong>@{agentName}</strong>
        <span>{agentDescription || "(no description)"}</span>
      </header>
      {loadError && <div className="auth-error">{loadError}</div>}
      <textarea
        value={draft}
        onChange={(e) =>
          canEdit ? setDraft(e.target.value.slice(0, cap)) : undefined
        }
        readOnly={!canEdit}
        rows={6}
        placeholder={
          info?.memory
            ? ""
            : "Empty — the hourly refresh will populate this once the agent sees new activity."
        }
      />
      <div className="memory-panel__meta">
        <span>
          {draft.length} / {cap}
        </span>
        <span>{statusLabel(info)}</span>
      </div>
      {canEdit && (
        <button type="button" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </button>
      )}
      {msg && <div className="auth-ok">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}
    </div>
  );
}
