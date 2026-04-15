/** Shared types and fetch helpers for the Bunny API. */

import type { SseEvent } from "../../src/agent/sse_events";

export type ServerEvent = SseEvent;

export interface SessionSummary {
  sessionId: string;
  title: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  project: string;
}

export type ProjectVisibility = "public" | "private";

export interface Project {
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  appendMode: boolean;
  /** null = inherit the global [memory] default (bunny.config.toml). */
  lastN: number | null;
  /** null = inherit the global [memory] default (bunny.config.toml). */
  recallK: number | null;
}

export interface StoredMessage {
  id: number;
  sessionId: string;
  ts: number;
  role: "system" | "user" | "assistant" | "tool";
  channel: "content" | "reasoning" | "tool_call" | "tool_result";
  content: string | null;
  toolCallId: string | null;
  toolName: string | null;
  providerSig: string | null;
  ok: boolean | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  project: string;
  /** Responding agent name, null for the default assistant / user rows. */
  author: string | null;
}

export interface TurnStats {
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Older turns were persisted as [content, reasoning]; newer turns as
 * [reasoning, content]. Swap any legacy pair so the thinking block always
 * renders above its answer.
 */
export function reorderReasoning(messages: StoredMessage[]): StoredMessage[] {
  const out = messages.slice();
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (
      a.role === "assistant" &&
      b.role === "assistant" &&
      a.channel === "content" &&
      b.channel === "reasoning"
    ) {
      out[i] = b;
      out[i + 1] = a;
    }
  }
  return out;
}

/** One assistant turn reconstructed from stored rows — matches the shape that
 * `useSSEChat` produces for live streaming, so history and live conversation
 * render identically. */
export interface HistoryTurn {
  id: string;
  prompt: string;
  reasoning: string;
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: string;
    output?: string;
    ok?: boolean;
  }>;
  /** Aggregated over every LLM call inside this user turn. */
  stats: TurnStats | null;
  /** Agent name that answered, or null for the default assistant. */
  author: string | null;
}

/** Group rows into turns: every user message opens a new turn and all following
 * assistant/tool rows fold into it until the next user message. Tool_call and
 * tool_result rows are paired by tool_call_id so a reloaded conversation shows
 * the same {args + output + ok} card as a live one. */
export function groupTurns(messages: StoredMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      current = {
        id: `turn-${m.id}`,
        prompt: m.content ?? "",
        reasoning: "",
        content: "",
        toolCalls: [],
        stats: null,
        author: null,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;

    if (m.role === "assistant" && m.channel === "reasoning") {
      current.reasoning += (current.reasoning ? "\n\n" : "") + (m.content ?? "");
      if (m.author) current.author = m.author;
    } else if (m.role === "assistant" && m.channel === "content") {
      current.content += (current.content ? "\n\n" : "") + (m.content ?? "");
      if (m.author) current.author = m.author;
      if (m.durationMs != null) {
        current.stats = {
          durationMs: (current.stats?.durationMs ?? 0) + m.durationMs,
          promptTokens: (current.stats?.promptTokens ?? 0) + (m.promptTokens ?? 0),
          completionTokens: (current.stats?.completionTokens ?? 0) + (m.completionTokens ?? 0),
        };
      }
    } else if (m.role === "assistant" && m.channel === "tool_call") {
      current.toolCalls.push({
        id: m.toolCallId ?? `anon-${m.id}`,
        name: m.toolName ?? "tool",
        args: m.content ?? "",
      });
    } else if (m.role === "tool" && m.channel === "tool_result") {
      const match = m.toolCallId
        ? current.toolCalls.find((tc) => tc.id === m.toolCallId)
        : undefined;
      if (match) {
        match.output = m.content ?? "";
        match.ok = m.ok ?? true;
      } else {
        // Legacy row (tool_call not persisted) — synthesise a card with just the result.
        current.toolCalls.push({
          id: m.toolCallId ?? `anon-${m.id}`,
          name: m.toolName ?? "tool",
          args: "",
          output: m.content ?? "",
          ok: m.ok ?? true,
        });
      }
    }
  }
  return turns;
}

export async function fetchSessions(
  search?: string,
  opts: { scope?: "mine" | "all"; project?: string } = {},
): Promise<SessionSummary[]> {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.project) params.set("project", opts.project);
  const qs = params.toString();
  const url = qs ? `/api/sessions?${qs}` : "/api/sessions";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const data = (await res.json()) as { sessions: SessionSummary[] };
  return data.sessions;
}

export async function fetchMessages(sessionId: string): Promise<StoredMessage[]> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const data = (await res.json()) as { messages: StoredMessage[] };
  return data.messages;
}

export async function createSession(): Promise<string> {
  const res = await fetch("/api/sessions", { method: "POST", credentials: "include" });
  if (!res.ok) throw new Error(`POST /api/sessions → ${res.status}`);
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

/**
 * Open an SSE chat stream. Calls `onEvent` for every parsed JSON payload.
 * Returns a promise that resolves when the stream ends and an abort function.
 */
export function streamChat(
  body: { sessionId: string; prompt: string; project?: string; agent?: string },
  onEvent: (ev: ServerEvent) => void,
): { done: Promise<void>; abort: () => void } {
  const controller = new AbortController();

  const done = (async () => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      let msg = `POST /api/chat → ${res.status}`;
      try {
        const err = (await res.json()) as { error?: string };
        if (err?.error) msg = err.error;
      } catch {
        // ignore — body wasn't JSON
      }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames separated by "\n\n".
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload) as ServerEvent);
          } catch {
            // Skip malformed frames rather than killing the stream.
          }
        }
      }
    }
  })();

  return { done, abort: () => controller.abort() };
}

// ── Auth & user management ──────────────────────────────────────────────────

export type UserRole = "admin" | "user";

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  displayName: string | null;
  email: string | null;
  mustChangePassword: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeyMeta {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `${init.method ?? "GET"} ${url} → ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err?.error) msg = err.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const { user } = await jsonFetch<{ user: AuthUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return user;
}

export async function logout(): Promise<void> {
  await jsonFetch<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const { user } = await jsonFetch<{ user: AuthUser }>("/api/auth/me");
    return user;
  } catch {
    return null;
  }
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  await jsonFetch<{ ok: true }>("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function updateOwnProfile(patch: {
  displayName?: string | null;
  email?: string | null;
}): Promise<AuthUser> {
  const { user } = await jsonFetch<{ user: AuthUser }>("/api/users/me", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return user;
}

export async function listUsers(q = ""): Promise<AuthUser[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const { users } = await jsonFetch<{ users: AuthUser[] }>(`/api/users${qs}`);
  return users;
}

export async function adminCreateUser(input: {
  username: string;
  password: string;
  role: UserRole;
  displayName?: string;
  email?: string;
}): Promise<AuthUser> {
  const { user } = await jsonFetch<{ user: AuthUser }>("/api/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return user;
}

export async function adminUpdateUser(
  id: string,
  patch: { role?: UserRole; displayName?: string | null; email?: string | null },
): Promise<AuthUser> {
  const { user } = await jsonFetch<{ user: AuthUser }>(`/api/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return user;
}

export async function adminResetPassword(id: string, password: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/users/${encodeURIComponent(id)}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function adminDeleteUser(id: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listMyApiKeys(): Promise<ApiKeyMeta[]> {
  const { keys } = await jsonFetch<{ keys: ApiKeyMeta[] }>("/api/apikeys");
  return keys;
}

export async function createMyApiKey(
  name: string,
  opts: { ttlDays?: number } = {},
): Promise<{ key: string; meta: ApiKeyMeta }> {
  return jsonFetch<{ key: string; meta: ApiKeyMeta }>("/api/apikeys", {
    method: "POST",
    body: JSON.stringify({ name, ttlDays: opts.ttlDays }),
  });
}

export async function revokeMyApiKey(id: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/apikeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function fetchProjects(): Promise<Project[]> {
  const { projects } = await jsonFetch<{ projects: Project[] }>("/api/projects");
  return projects;
}

export async function fetchProject(name: string): Promise<Project> {
  const { project } = await jsonFetch<{ project: Project }>(
    `/api/projects/${encodeURIComponent(name)}`,
  );
  return project;
}

export async function createProject(input: {
  name: string;
  description?: string;
  systemPrompt?: string;
  appendMode?: boolean;
  visibility?: ProjectVisibility;
  lastN?: number | null;
  recallK?: number | null;
}): Promise<Project> {
  const { project } = await jsonFetch<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return project;
}

export async function updateProject(
  name: string,
  patch: {
    description?: string | null;
    systemPrompt?: string;
    appendMode?: boolean;
    visibility?: ProjectVisibility;
    lastN?: number | null;
    recallK?: number | null;
  },
): Promise<Project> {
  const { project } = await jsonFetch<{ project: Project }>(
    `/api/projects/${encodeURIComponent(name)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return project;
}

export async function deleteProject(name: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ── Agents ──────────────────────────────────────────────────────────────────

export type AgentVisibility = "public" | "private";
export type AgentContextScope = "full" | "own";

export interface Agent {
  name: string;
  description: string;
  visibility: AgentVisibility;
  isSubagent: boolean;
  knowsOtherAgents: boolean;
  contextScope: AgentContextScope;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  appendMode: boolean;
  /** null = inherit every registered tool. */
  tools: string[] | null;
  allowedSubagents: string[];
  /** null = inherit project / global default. */
  lastN: number | null;
  /** null = inherit project / global default. */
  recallK: number | null;
  /** Projects this agent is linked to (opt-in availability). */
  projects: string[];
}

export interface AgentInput {
  name: string;
  description?: string;
  visibility?: AgentVisibility;
  isSubagent?: boolean;
  knowsOtherAgents?: boolean;
  contextScope?: AgentContextScope;
  systemPrompt?: string;
  appendMode?: boolean;
  tools?: string[] | null;
  allowedSubagents?: string[];
  lastN?: number | null;
  recallK?: number | null;
}

export async function fetchAgents(): Promise<Agent[]> {
  const { agents } = await jsonFetch<{ agents: Agent[] }>("/api/agents");
  return agents;
}

export async function createAgent(input: AgentInput): Promise<Agent> {
  const { agent } = await jsonFetch<{ agent: Agent }>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return agent;
}

export async function updateAgent(name: string, patch: Omit<AgentInput, "name">): Promise<Agent> {
  const { agent } = await jsonFetch<{ agent: Agent }>(
    `/api/agents/${encodeURIComponent(name)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return agent;
}

export async function deleteAgent(name: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function fetchProjectAgents(project: string): Promise<Agent[]> {
  const { agents } = await jsonFetch<{ agents: Agent[] }>(
    `/api/projects/${encodeURIComponent(project)}/agents`,
  );
  return agents;
}

export async function linkAgentToProject(project: string, agent: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/projects/${encodeURIComponent(project)}/agents`, {
    method: "POST",
    body: JSON.stringify({ agent }),
  });
}

export async function unlinkAgentFromProject(project: string, agent: string): Promise<void> {
  await jsonFetch<{ ok: true }>(
    `/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}`,
    { method: "DELETE" },
  );
}

export async function fetchToolNames(): Promise<string[]> {
  const { tools } = await jsonFetch<{ tools: string[] }>("/api/tools");
  return tools;
}
