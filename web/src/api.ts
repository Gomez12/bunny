/** Shared types and fetch helpers for the Bunny API. */

import type { SseEvent } from "../../src/agent/sse_events";
import type { ChatAttachment } from "../../src/llm/types";

export type Theme = "light" | "dark";

/** Payload that Documents / Whiteboards / Contacts hand off to Chat so the
 *  arriving session auto-sends one prompt as a Quick Chat. */
export interface OpenInChatPayload {
  prompt: string;
  attachments?: ChatAttachment[];
  isQuickChat?: boolean;
}

export type OpenInChatFn = (
  sessionId: string,
  payload: OpenInChatPayload,
) => void;

export type ServerEvent = SseEvent;
export type { ChatAttachment };

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
  /** True iff the *current viewer* has hidden this session from their chat sidebar. */
  hiddenFromChat: boolean;
  /** True iff the viewer has marked this session as a Quick Chat. */
  isQuickChat: boolean;
  /** Source session id when this session was created via "Fork to Quick Chat". */
  forkedFromSessionId: string | null;
}

export type ProjectVisibility = "public" | "private";

export interface Project {
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  languages: string[];
  defaultLanguage: string;
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

export type TranslationKind =
  | "kb_definition"
  | "document"
  | "contact"
  | "board_card";

export type TranslationStatus =
  | "pending"
  | "translating"
  | "ready"
  | "error";

export interface TranslationDto {
  id: number;
  lang: string;
  status: TranslationStatus;
  error: string | null;
  sourceVersion: number;
  sourceHash: string | null;
  translatingAt: number | null;
  isOrphaned: boolean;
  fields: Record<string, string | null>;
  createdAt: number;
  updatedAt: number;
}

export interface TranslationsResponse {
  kind: TranslationKind;
  entityId: number;
  projectLanguages: string[];
  defaultLanguage: string;
  translations: TranslationDto[];
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
  /** User-turn attachments (images). Null when absent. */
  attachments: ChatAttachment[] | null;
  /** Unix ms when this message was edited via the edit affordance (null = never). */
  editedAt: number | null;
  /** Original assistant message id this row regenerates (null = root / not a regen). */
  regenOfMessageId: number | null;
  /** Ordered chain of all versions (root first). Length 1 = no regenerations. */
  regenChain: Array<{ id: number; ts: number; content: string | null }>;
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
  /** DB id of the user prompt row (used for edit/fork/trim affordances). */
  promptMessageId: number;
  /** True iff the user prompt has been edited at least once. */
  promptEdited: boolean;
  reasoning: string;
  content: string;
  /** DB id of the assistant content row that produced `content` (the active version). */
  contentMessageId: number | null;
  /** True iff the active assistant content row has been edited at least once. */
  contentEdited: boolean;
  /**
   * All versions of this assistant answer (ordered, root first). Length 1 =
   * no regenerations. The `id` of the *active* version is `contentMessageId`.
   */
  regenChain: Array<{ id: number; ts: number; content: string | null }>;
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
  /** Attachments sent by the user on this turn. */
  attachments: ChatAttachment[];
}

/** Group rows into turns: every user message opens a new turn and all following
 * assistant/tool rows fold into it until the next user message. Tool_call and
 * tool_result rows are paired by tool_call_id so a reloaded conversation shows
 * the same {args + output + ok} card as a live one. */
export function groupTurns(messages: StoredMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;

  // Index assistant content rows by their regen-chain root, so that when we
  // walk the linear stream we can pick the *active* (latest) version per turn.
  const rootOf = new Map<number, number>(); // messageId -> root id
  const versionsByRoot = new Map<number, StoredMessage[]>();
  for (const m of messages) {
    if (m.role !== "assistant" || m.channel !== "content") continue;
    const root = m.regenOfMessageId
      ? rootOf.get(m.regenOfMessageId) ?? m.regenOfMessageId
      : m.id;
    rootOf.set(m.id, root);
    let bucket = versionsByRoot.get(root);
    if (!bucket) {
      bucket = [];
      versionsByRoot.set(root, bucket);
    }
    bucket.push(m);
  }
  // Sort each bucket so the active (latest by ts) version is last.
  for (const arr of versionsByRoot.values()) {
    arr.sort((a, b) => a.ts - b.ts || a.id - b.id);
  }
  // For non-active versions, remember which root they belong to so we can skip
  // them entirely (the active version stands in for the whole chain).
  const skipIds = new Set<number>();
  for (const arr of versionsByRoot.values()) {
    for (let i = 0; i < arr.length - 1; i++) skipIds.add(arr[i]!.id);
  }

  for (const m of messages) {
    if (m.role === "user") {
      current = {
        id: `turn-${m.id}`,
        prompt: m.content ?? "",
        promptMessageId: m.id,
        promptEdited: m.editedAt != null,
        reasoning: "",
        content: "",
        contentMessageId: null,
        contentEdited: false,
        regenChain: [],
        toolCalls: [],
        stats: null,
        author: null,
        attachments: m.attachments ?? [],
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    // Skip superseded assistant content rows entirely — only the active
    // version of a regen chain participates in the rendered turn.
    if (skipIds.has(m.id)) continue;

    if (m.role === "assistant" && m.channel === "reasoning") {
      current.reasoning += (current.reasoning ? "\n\n" : "") + (m.content ?? "");
      if (m.author) current.author = m.author;
    } else if (m.role === "assistant" && m.channel === "content") {
      current.content += (current.content ? "\n\n" : "") + (m.content ?? "");
      current.contentMessageId = m.id;
      current.contentEdited = m.editedAt != null;
      current.regenChain = m.regenChain ?? [
        { id: m.id, ts: m.ts, content: m.content },
      ];
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
  opts: { scope?: "mine" | "all"; project?: string; excludeHidden?: boolean } = {},
): Promise<SessionSummary[]> {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.project) params.set("project", opts.project);
  if (opts.excludeHidden) params.set("excludeHidden", "1");
  const qs = params.toString();
  const url = qs ? `/api/sessions?${qs}` : "/api/sessions";
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const data = (await res.json()) as { sessions: SessionSummary[] };
  return data.sessions;
}

export async function setSessionHiddenFromChat(
  sessionId: string,
  hiddenFromChat: boolean,
): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ hiddenFromChat }),
  });
}

export async function setSessionQuickChat(
  sessionId: string,
  isQuickChat: boolean,
): Promise<void> {
  await jsonFetch<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/quick-chat`,
    { method: "PATCH", body: JSON.stringify({ isQuickChat }) },
  );
}

export async function forkSessionApi(
  srcSessionId: string,
  opts: {
    untilMessageId?: number | null;
    asQuickChat?: boolean;
    project?: string;
    /** Overwrite the last copied message's content in the new session only.
     *  Used by the "edit then fork" affordance — the source row is untouched. */
    editLastMessageContent?: string;
  } = {},
): Promise<{ sessionId: string; project: string; copiedCount: number }> {
  return jsonFetch<{ sessionId: string; project: string; copiedCount: number }>(
    `/api/sessions/${encodeURIComponent(srcSessionId)}/fork`,
    { method: "POST", body: JSON.stringify(opts) },
  );
}

export async function patchMessage(messageId: number, content: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

export async function trimMessagesAfter(messageId: number): Promise<{ trimmedCount: number }> {
  const res = await jsonFetch<{ ok: true; trimmedCount: number }>(
    `/api/messages/${messageId}/trim-after`,
    { method: "POST" },
  );
  return { trimmedCount: res.trimmedCount };
}

/**
 * Open an SSE stream and dispatch each `data:` payload to `onEvent`.
 * Used by every front-end SSE consumer (chat, regenerate, card runs) — the
 * frame parser, error decoding, and abort plumbing live exactly once here.
 */
function openSseStream(
  url: string,
  init: RequestInit,
  onEvent: (ev: ServerEvent) => void,
): { done: Promise<void>; abort: () => void } {
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(url, {
      credentials: "include",
      ...init,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      let msg = `${init.method ?? "GET"} ${url} → ${res.status}`;
      try {
        const err = (await res.json()) as { error?: string };
        if (err?.error) msg = err.error;
      } catch {
        // body wasn't JSON
      }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
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
            // skip malformed frames rather than killing the stream
          }
        }
      }
    }
  })();
  return { done, abort: () => controller.abort() };
}

/**
 * Regenerate an assistant message as an alternate version. The new assistant
 * row carries `regen_of_message_id = messageId` server-side.
 */
export function regenerateAssistantMessage(
  messageId: number,
  onEvent: (ev: ServerEvent) => void,
): { done: Promise<void>; abort: () => void } {
  return openSseStream(
    `/api/messages/${messageId}/regenerate`,
    { method: "POST" },
    onEvent,
  );
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
  body: {
    sessionId: string;
    prompt: string;
    project?: string;
    agent?: string;
    attachments?: ChatAttachment[];
  },
  onEvent: (ev: ServerEvent) => void,
): { done: Promise<void>; abort: () => void } {
  return openSseStream(
    "/api/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    onEvent,
  );
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
  expandThinkBubbles: boolean;
  expandToolBubbles: boolean;
  preferredLanguage: string | null;
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
  expandThinkBubbles?: boolean;
  expandToolBubbles?: boolean;
  preferredLanguage?: string | null;
}): Promise<AuthUser> {
  const { user } = await jsonFetch<{ user: AuthUser }>("/api/users/me", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return user;
}

export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string | null;
}

export async function fetchUserDirectory(q = ""): Promise<DirectoryUser[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const { users } = await jsonFetch<{ users: DirectoryUser[] }>(`/api/users/directory${qs}`);
  return users;
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
  languages?: string[];
  defaultLanguage?: string;
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
    languages?: string[];
    defaultLanguage?: string;
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

// ── Translations ────────────────────────────────────────────────────────────

export async function fetchTranslations(
  project: string,
  kind: TranslationKind,
  entityId: number,
): Promise<TranslationsResponse> {
  return jsonFetch<TranslationsResponse>(
    `/api/projects/${encodeURIComponent(project)}/translations/${kind}/${entityId}`,
  );
}

export async function triggerTranslate(
  project: string,
  kind: TranslationKind,
  entityId: number,
  lang: string,
): Promise<void> {
  await jsonFetch<{ ok: true }>(
    `/api/projects/${encodeURIComponent(project)}/translations/${kind}/${entityId}/${lang}`,
    { method: "POST" },
  );
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

// ── Skills ─────────────────────────────────────────────────────────────────

export type SkillVisibility = "public" | "private";

export interface Skill {
  name: string;
  description: string;
  visibility: SkillVisibility;
  sourceUrl: string | null;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  skillMd: string;
  allowedTools: string[];
  projects: string[];
}

export interface SkillInput {
  name: string;
  description?: string;
  visibility?: SkillVisibility;
  skillMd?: string;
}

export async function fetchSkills(): Promise<Skill[]> {
  const { skills } = await jsonFetch<{ skills: Skill[] }>("/api/skills");
  return skills;
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const { skill } = await jsonFetch<{ skill: Skill }>("/api/skills", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return skill;
}

export async function installSkill(url: string, name?: string): Promise<Skill> {
  const { skill } = await jsonFetch<{ skill: Skill }>("/api/skills/install", {
    method: "POST",
    body: JSON.stringify({ url, name }),
  });
  return skill;
}

export async function updateSkill(
  name: string,
  patch: Omit<SkillInput, "name">,
): Promise<Skill> {
  const { skill } = await jsonFetch<{ skill: Skill }>(
    `/api/skills/${encodeURIComponent(name)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return skill;
}

export async function deleteSkill(name: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function fetchProjectSkills(project: string): Promise<Skill[]> {
  const { skills } = await jsonFetch<{ skills: Skill[] }>(
    `/api/projects/${encodeURIComponent(project)}/skills`,
  );
  return skills;
}

export async function linkSkillToProject(project: string, skill: string): Promise<void> {
  await jsonFetch<{ ok: true }>(
    `/api/projects/${encodeURIComponent(project)}/skills`,
    { method: "POST", body: JSON.stringify({ skill }) },
  );
}

export async function unlinkSkillFromProject(project: string, skill: string): Promise<void> {
  await jsonFetch<{ ok: true }>(
    `/api/projects/${encodeURIComponent(project)}/skills/${encodeURIComponent(skill)}`,
    { method: "DELETE" },
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export interface Swimlane {
  id: number;
  project: string;
  name: string;
  position: number;
  wipLimit: number | null;
  autoRun: boolean;
  defaultAssigneeUserId: string | null;
  defaultAssigneeAgent: string | null;
  nextSwimlaneId: number | null;
  color: string | null;
  group: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoardCard {
  id: number;
  project: string;
  swimlaneId: number;
  position: number;
  title: string;
  description: string;
  assigneeUserId: string | null;
  assigneeAgent: string | null;
  autoRun: boolean;
  estimateHours: number | null;
  percentDone: number | null;
  originalLang: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  latestRunStatus?: "queued" | "running" | "done" | "error" | null;
}

export interface CardRun {
  id: number;
  cardId: number;
  sessionId: string;
  agent: string;
  triggeredBy: string;
  triggerKind: "manual" | "scheduled";
  status: "queued" | "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  finalAnswer: string | null;
  error: string | null;
}

export interface BoardSnapshot {
  project: string;
  swimlanes: Swimlane[];
  cards: BoardCard[];
}

export async function fetchBoard(project: string): Promise<BoardSnapshot> {
  return jsonFetch<BoardSnapshot>(`/api/projects/${encodeURIComponent(project)}/board`);
}

export async function createSwimlane(
  project: string,
  input: {
    name: string;
    position?: number;
    wipLimit?: number | null;
    autoRun?: boolean;
    defaultAssigneeUserId?: string | null;
    defaultAssigneeAgent?: string | null;
    nextSwimlaneId?: number | null;
    color?: string | null;
    group?: string | null;
  },
): Promise<Swimlane> {
  const { swimlane } = await jsonFetch<{ swimlane: Swimlane }>(
    `/api/projects/${encodeURIComponent(project)}/swimlanes`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return swimlane;
}

export async function patchSwimlane(
  id: number,
  patch: {
    name?: string;
    position?: number;
    wipLimit?: number | null;
    autoRun?: boolean;
    defaultAssigneeUserId?: string | null;
    defaultAssigneeAgent?: string | null;
    nextSwimlaneId?: number | null;
    color?: string | null;
    group?: string | null;
  },
): Promise<Swimlane> {
  const { swimlane } = await jsonFetch<{ swimlane: Swimlane }>(`/api/swimlanes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return swimlane;
}

export async function deleteSwimlane(id: number): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/swimlanes/${id}`, { method: "DELETE" });
}

export interface CardInput {
  swimlaneId: number;
  title: string;
  description?: string;
  assigneeUserId?: string | null;
  assigneeAgent?: string | null;
  autoRun?: boolean;
  estimateHours?: number | null;
  percentDone?: number | null;
}

export async function createCard(project: string, input: CardInput): Promise<BoardCard> {
  const { card } = await jsonFetch<{ card: BoardCard }>(
    `/api/projects/${encodeURIComponent(project)}/cards`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return card;
}

export async function fetchCard(id: number): Promise<{ card: BoardCard; runs: CardRun[] }> {
  return jsonFetch<{ card: BoardCard; runs: CardRun[] }>(`/api/cards/${id}`);
}

export async function patchCard(
  id: number,
  patch: Partial<CardInput> & { position?: number },
): Promise<BoardCard> {
  const { card } = await jsonFetch<{ card: BoardCard }>(`/api/cards/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return card;
}

export async function moveCard(
  id: number,
  input: { swimlaneId?: number; beforeCardId?: number; afterCardId?: number; position?: number },
): Promise<BoardCard> {
  const { card } = await jsonFetch<{ card: BoardCard }>(`/api/cards/${id}/move`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return card;
}

export async function archiveCard(id: number): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/cards/${id}`, { method: "DELETE" });
}

export async function fetchCardRuns(id: number): Promise<CardRun[]> {
  const { runs } = await jsonFetch<{ runs: CardRun[] }>(`/api/cards/${id}/runs`);
  return runs;
}

/** Kick off a new run. Returns 202 with `{ run, sessionId }`. */
export async function runCard(
  cardId: number,
  input: { agent?: string; sessionId?: string } = {},
): Promise<{ run: CardRun; sessionId: string }> {
  return jsonFetch<{ run: CardRun; sessionId: string }>(`/api/cards/${cardId}/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Subscribe to a live card-run SSE stream. Returns the same shape as
 * {@link streamChat}. The server returns 409 if the run already finished —
 * caller should fall back to {@link fetchMessages} on the run's session id.
 */
export function streamCardRun(
  cardId: number,
  runId: number,
  onEvent: (ev: ServerEvent) => void,
): { done: Promise<void>; abort: () => void } {
  return openSseStream(
    `/api/cards/${cardId}/runs/${runId}/stream`,
    { method: "GET" },
    onEvent,
  );
}

// ── Scheduled tasks ─────────────────────────────────────────────────────────

export type TaskKind = "system" | "user";
export type TaskStatus = "ok" | "error";

export interface ScheduledTask {
  id: string;
  kind: TaskKind;
  handler: string;
  name: string;
  description: string | null;
  cronExpr: string;
  payload: unknown;
  enabled: boolean;
  ownerUserId: string | null;
  lastRunAt: number | null;
  lastStatus: TaskStatus | null;
  lastError: string | null;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskInput {
  kind: TaskKind;
  handler: string;
  name: string;
  description?: string | null;
  cronExpr: string;
  payload?: unknown;
  enabled?: boolean;
}

export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const { tasks } = await jsonFetch<{ tasks: ScheduledTask[] }>("/api/tasks");
  return tasks;
}

export async function listTaskHandlers(): Promise<string[]> {
  const { handlers } = await jsonFetch<{ handlers: string[] }>("/api/tasks/handlers");
  return handlers;
}

export async function createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
  const { task } = await jsonFetch<{ task: ScheduledTask }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return task;
}

export async function patchScheduledTask(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    cronExpr?: string;
    payload?: unknown;
    enabled?: boolean;
  },
): Promise<ScheduledTask> {
  const { task } = await jsonFetch<{ task: ScheduledTask }>(
    `/api/tasks/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return task;
}

export async function deleteScheduledTask(id: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runScheduledTaskNow(id: string): Promise<ScheduledTask | null> {
  const { task } = await jsonFetch<{ task: ScheduledTask | null }>(
    `/api/tasks/${encodeURIComponent(id)}/run-now`,
    { method: "POST" },
  );
  return task;
}

// ── Events (admin Logs tab) ───────────────────────────────────────────────

export interface LogEvent {
  id: number;
  ts: number;
  topic: string;
  kind: string;
  sessionId: string | null;
  userId: string | null;
  durationMs: number | null;
  error: string | null;
  payloadJson: string | null;
}

export interface EventsFilter {
  topic?: string;
  kind?: string;
  sessionId?: string;
  userId?: string;
  errorsOnly?: boolean;
  fromTs?: number;
  toTs?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

function buildEventsQuery(f: EventsFilter): string {
  const p = new URLSearchParams();
  if (f.topic) p.set("topic", f.topic);
  if (f.kind) p.set("kind", f.kind);
  if (f.sessionId) p.set("session_id", f.sessionId);
  if (f.userId) p.set("user_id", f.userId);
  if (f.errorsOnly) p.set("errors_only", "1");
  if (typeof f.fromTs === "number") p.set("from", String(f.fromTs));
  if (typeof f.toTs === "number") p.set("to", String(f.toTs));
  if (f.q) p.set("q", f.q);
  if (typeof f.limit === "number") p.set("limit", String(f.limit));
  if (typeof f.offset === "number") p.set("offset", String(f.offset));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export async function listEvents(
  f: EventsFilter = {},
): Promise<{ items: LogEvent[]; total: number }> {
  return jsonFetch<{ items: LogEvent[]; total: number }>(`/api/events${buildEventsQuery(f)}`);
}

export async function listEventFacets(): Promise<{ topics: string[]; kinds: string[] }> {
  return jsonFetch<{ topics: string[]; kinds: string[] }>(`/api/events/facets`);
}

// ── Workspace (per-project files) ───────────────────────────────────────────

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

export async function listWorkspace(
  project: string,
  path = "",
): Promise<{ project: string; path: string; entries: WorkspaceEntry[] }> {
  const qs = new URLSearchParams({ path });
  return jsonFetch(`/api/projects/${encodeURIComponent(project)}/workspace/list?${qs}`);
}

export async function uploadWorkspaceFiles(
  project: string,
  targetDir: string,
  files: File[],
): Promise<{ entries: WorkspaceEntry[] }> {
  const form = new FormData();
  if (targetDir) form.append("path", targetDir);
  for (const f of files) form.append("file", f, f.name);
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/workspace/file`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) {
    let msg = `upload failed: ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err?.error) msg = err.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { entries: WorkspaceEntry[] };
}

export async function deleteWorkspaceEntry(project: string, path: string): Promise<void> {
  const qs = new URLSearchParams({ path });
  await jsonFetch(`/api/projects/${encodeURIComponent(project)}/workspace?${qs}`, {
    method: "DELETE",
  });
}

export async function mkdirWorkspace(
  project: string,
  path: string,
): Promise<{ entry: WorkspaceEntry }> {
  return jsonFetch(`/api/projects/${encodeURIComponent(project)}/workspace/mkdir`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function moveWorkspaceEntry(
  project: string,
  from: string,
  to: string,
): Promise<{ entry: WorkspaceEntry }> {
  return jsonFetch(`/api/projects/${encodeURIComponent(project)}/workspace/move`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

/**
 * Upload an image file to the server which returns it as a base64 data URL.
 * This bypasses all client-side File reading APIs (FileReader, arrayBuffer,
 * fetch-on-blob) which Safari 26+ blocks on drag-and-drop and file-picker
 * File objects. The browser's native FormData serialisation is always allowed.
 */
export async function uploadImageForDataUrl(
  file: File,
  mime: string,
): Promise<ChatAttachment> {
  const form = new FormData();
  // Ensure the File carries the right MIME even when the browser left it blank.
  const blob = file.type === mime ? file : new File([file], file.name, { type: mime });
  form.append("file", blob, file.name);
  const res = await fetch("/api/upload-image", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) {
    let msg = `upload failed: ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = (await res.json()) as { mime: string; dataUrl: string };
  return { kind: "image", mime: data.mime, dataUrl: data.dataUrl };
}

export function workspaceDownloadUrl(project: string, path: string): string {
  const qs = new URLSearchParams({ path, encoding: "raw" });
  return `/api/projects/${encodeURIComponent(project)}/workspace/file?${qs}`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export type DashboardRange = "24h" | "7d" | "30d" | "90d" | "all";

export interface DashboardData {
  kpi: {
    totalMessages: number;
    totalSessions: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    avgResponseMs: number | null;
  };
  activityOverTime: Array<{ ts: number; count: number }>;
  tokensOverTime: Array<{ ts: number; prompt: number; completion: number }>;
  responseTimeOverTime: Array<{ ts: number; avgMs: number }>;
  toolUsage: Array<{ name: string; count: number }>;
  agentActivity: Array<{ agent: string; count: number }>;
  projectActivity: Array<{ project: string; count: number }>;
  boardOverview: Array<{ lane: string; count: number }>;
  cardRunStatus: Array<{ status: string; count: number }>;
  errorRate: { total: number; errors: number };
  recentActivity: Array<{
    id: number;
    ts: number;
    topic: string;
    kind: string;
    sessionId: string | null;
    userId: string | null;
    durationMs: number | null;
    error: string | null;
  }>;
  scheduler: { total: number; enabled: number; errored: number; nextDue: number | null };
}

export async function fetchDashboard(range: DashboardRange = "7d"): Promise<DashboardData> {
  return jsonFetch<DashboardData>(`/api/dashboard?range=${range}`);
}

// ── UI Config ───────────────────────────────────────────────────────────

export interface UiConfig {
  autosaveIntervalMs: number;
}

export async function fetchUiConfig(): Promise<UiConfig> {
  return jsonFetch<UiConfig>("/api/config/ui");
}

// ── Whiteboards ─────────────────────────────────────────────────────────

export interface WhiteboardSummary {
  id: number;
  name: string;
  thumbnail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WhiteboardFull extends WhiteboardSummary {
  project: string;
  elementsJson: string;
  appStateJson: string | null;
  createdBy: string | null;
}

export async function fetchWhiteboards(project: string): Promise<WhiteboardSummary[]> {
  const data = await jsonFetch<{ whiteboards: WhiteboardSummary[] }>(
    `/api/projects/${encodeURIComponent(project)}/whiteboards`,
  );
  return data.whiteboards;
}

export async function fetchWhiteboard(id: number): Promise<WhiteboardFull> {
  const data = await jsonFetch<{ whiteboard: WhiteboardFull }>(`/api/whiteboards/${id}`);
  return data.whiteboard;
}

export async function createWhiteboard(project: string, name: string): Promise<WhiteboardFull> {
  const data = await jsonFetch<{ whiteboard: WhiteboardFull }>(
    `/api/projects/${encodeURIComponent(project)}/whiteboards`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  return data.whiteboard;
}

export async function patchWhiteboard(
  id: number,
  patch: { name?: string; elementsJson?: string; appStateJson?: string | null; thumbnail?: string | null },
): Promise<WhiteboardFull> {
  const data = await jsonFetch<{ whiteboard: WhiteboardFull }>(`/api/whiteboards/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.whiteboard;
}

export async function deleteWhiteboard(id: number): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/api/whiteboards/${id}`, { method: "DELETE" });
}

export async function editWhiteboard(
  id: number,
  body: { prompt: string; elementsJson: string; screenshotDataUrl?: string },
): Promise<Response> {
  return fetch(`/api/whiteboards/${id}/edit`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface AskResponse {
  sessionId: string;
  project: string;
  prompt: string;
  attachments?: ChatAttachment[];
  isQuickChat: boolean;
}

export async function askWhiteboard(
  id: number,
  body: { prompt: string; elementsJson?: string; thumbnail?: string },
): Promise<AskResponse> {
  return jsonFetch<AskResponse>(`/api/whiteboards/${id}/ask`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Documents ────────────────────────────────────────────────────────────────

export interface DocumentSummary {
  id: number;
  name: string;
  thumbnail: string | null;
  isTemplate: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentFull extends DocumentSummary {
  project: string;
  contentMd: string;
  originalLang: string | null;
  createdBy: string | null;
}

export async function fetchDocuments(
  project: string,
  opts?: { template?: boolean },
): Promise<DocumentSummary[]> {
  const params = opts?.template !== undefined ? `?template=${opts.template}` : "";
  const data = await jsonFetch<{ documents: DocumentSummary[] }>(
    `/api/projects/${encodeURIComponent(project)}/documents${params}`,
  );
  return data.documents;
}

export async function saveAsTemplate(id: number): Promise<DocumentFull> {
  const data = await jsonFetch<{ document: DocumentFull }>(`/api/documents/${id}/save-as-template`, {
    method: "POST",
  });
  return data.document;
}

export async function fetchDocument(id: number): Promise<DocumentFull> {
  const data = await jsonFetch<{ document: DocumentFull }>(`/api/documents/${id}`);
  return data.document;
}

export async function createDocument(project: string, name: string): Promise<DocumentFull> {
  const data = await jsonFetch<{ document: DocumentFull }>(
    `/api/projects/${encodeURIComponent(project)}/documents`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  return data.document;
}

export async function patchDocument(
  id: number,
  patch: { name?: string; contentMd?: string; thumbnail?: string | null },
): Promise<DocumentFull> {
  const data = await jsonFetch<{ document: DocumentFull }>(`/api/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.document;
}

export async function deleteDocument(id: number): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/api/documents/${id}`, { method: "DELETE" });
}

export async function editDocument(
  id: number,
  body: { prompt: string; contentMd?: string },
): Promise<Response> {
  return fetch(`/api/documents/${id}/edit`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function askDocument(
  id: number,
  body: { prompt: string; contentMd?: string },
): Promise<AskResponse> {
  return jsonFetch<AskResponse>(`/api/documents/${id}/ask`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadDocumentImage(
  id: number,
  file: File,
): Promise<{ url: string; path: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/documents/${id}/images`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ url: string; path: string }>;
}

export async function exportDocument(id: number, format: "docx" | "html"): Promise<Blob> {
  const res = await fetch(`/api/documents/${id}/export/${format}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export interface Contact {
  id: number;
  project: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  title: string;
  notes: string;
  avatar: string | null;
  tags: string[];
  groups: number[];
  originalLang: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContactGroup {
  id: number;
  project: string;
  name: string;
  color: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
}

export interface ContactInput {
  name: string;
  emails?: string[];
  phones?: string[];
  company?: string;
  title?: string;
  notes?: string;
  avatar?: string | null;
  tags?: string[];
  groups?: number[];
}

export async function fetchContacts(
  project: string,
  opts?: { q?: string; group?: number; limit?: number; offset?: number },
): Promise<{ contacts: Contact[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.group !== undefined) params.set("group", String(opts.group));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return jsonFetch(`/api/projects/${encodeURIComponent(project)}/contacts${qs ? `?${qs}` : ""}`);
}

export async function fetchContact(project: string, id: number): Promise<Contact> {
  const data = await jsonFetch<{ contact: Contact }>(
    `/api/projects/${encodeURIComponent(project)}/contacts/${id}`,
  );
  return data.contact;
}

export async function createContact(project: string, input: ContactInput): Promise<Contact> {
  const data = await jsonFetch<{ contact: Contact }>(
    `/api/projects/${encodeURIComponent(project)}/contacts`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.contact;
}

export async function updateContact(project: string, id: number, patch: Partial<ContactInput>): Promise<Contact> {
  const data = await jsonFetch<{ contact: Contact }>(
    `/api/projects/${encodeURIComponent(project)}/contacts/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.contact;
}

export async function deleteContact(project: string, id: number): Promise<void> {
  await jsonFetch(`/api/projects/${encodeURIComponent(project)}/contacts/${id}`, { method: "DELETE" });
}

export async function importContacts(
  project: string,
  contacts: ContactInput[],
): Promise<{ imported: number }> {
  return jsonFetch(`/api/projects/${encodeURIComponent(project)}/contacts/import`, {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
}

export function contactVcfUrl(project: string, id: number): string {
  return `/api/projects/${encodeURIComponent(project)}/contacts/${id}/vcf`;
}

export async function exportContactsVcf(project: string, ids: number[]): Promise<Blob> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/contacts/export`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}

export async function fetchContactGroups(project: string): Promise<ContactGroup[]> {
  const data = await jsonFetch<{ groups: ContactGroup[] }>(
    `/api/projects/${encodeURIComponent(project)}/contact-groups`,
  );
  return data.groups;
}

export async function createContactGroup(
  project: string,
  input: { name: string; color?: string },
): Promise<ContactGroup> {
  const data = await jsonFetch<{ group: ContactGroup }>(
    `/api/projects/${encodeURIComponent(project)}/contact-groups`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.group;
}

export async function updateContactGroup(
  project: string,
  id: number,
  patch: { name?: string; color?: string | null },
): Promise<ContactGroup> {
  const data = await jsonFetch<{ group: ContactGroup }>(
    `/api/projects/${encodeURIComponent(project)}/contact-groups/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.group;
}

export async function deleteContactGroup(project: string, id: number): Promise<void> {
  await jsonFetch(`/api/projects/${encodeURIComponent(project)}/contact-groups/${id}`, {
    method: "DELETE",
  });
}

export async function editContacts(
  project: string,
  body: { prompt: string; contactsSummary?: string },
): Promise<Response> {
  return fetch(`/api/projects/${encodeURIComponent(project)}/contacts/edit`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function askContacts(
  project: string,
  body: { prompt: string; contactsSummary?: string },
): Promise<AskResponse> {
  return jsonFetch<AskResponse>(`/api/projects/${encodeURIComponent(project)}/contacts/ask`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Knowledge Base: Definitions ─────────────────────────────────────────────

export type ActiveDescription = "manual" | "short" | "long";
export type LlmStatus = "idle" | "generating" | "error";

export interface DefinitionSource {
  title: string;
  url: string;
}

export interface Definition {
  id: number;
  project: string;
  term: string;
  manualDescription: string;
  llmShort: string | null;
  llmLong: string | null;
  llmSources: DefinitionSource[];
  llmCleared: boolean;
  llmStatus: LlmStatus;
  llmError: string | null;
  llmGeneratedAt: number | null;
  isProjectDependent: boolean;
  activeDescription: ActiveDescription;
  originalLang: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DefinitionInput {
  term: string;
  manualDescription?: string;
  isProjectDependent?: boolean;
  activeDescription?: ActiveDescription;
}

export async function fetchDefinitions(
  project: string,
  opts?: { q?: string; limit?: number; offset?: number },
): Promise<{ definitions: Definition[]; total: number }> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return jsonFetch(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions${qs ? `?${qs}` : ""}`,
  );
}

export async function createDefinition(
  project: string,
  input: DefinitionInput,
): Promise<Definition> {
  const data = await jsonFetch<{ definition: Definition }>(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.definition;
}

export async function updateDefinition(
  project: string,
  id: number,
  patch: Partial<DefinitionInput>,
): Promise<Definition> {
  const data = await jsonFetch<{ definition: Definition }>(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.definition;
}

export async function deleteDefinition(project: string, id: number): Promise<void> {
  await jsonFetch(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions/${id}`,
    { method: "DELETE" },
  );
}

export async function setDefinitionActive(
  project: string,
  id: number,
  active: ActiveDescription,
): Promise<Definition> {
  const data = await jsonFetch<{ definition: Definition }>(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions/${id}/active`,
    { method: "POST", body: JSON.stringify({ active }) },
  );
  return data.definition;
}

export async function clearDefinitionLlm(project: string, id: number): Promise<Definition> {
  const data = await jsonFetch<{ definition: Definition }>(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions/${id}/clear-llm`,
    { method: "POST" },
  );
  return data.definition;
}

/**
 * Kick off LLM generation for a definition. Returns the raw streaming Response
 * so the caller can parse SSE events (content / tool_call / tool_result /
 * kb_definition_generated / error / done).
 */
export async function streamGenerateDefinition(
  project: string,
  id: number,
): Promise<Response> {
  return fetch(
    `/api/projects/${encodeURIComponent(project)}/kb/definitions/${id}/generate`,
    { method: "POST", credentials: "include" },
  );
}

// ── Web News ────────────────────────────────────────────────────────────────

export type NewsRunStatus = "idle" | "running";
export type NewsLastRunStatus = "ok" | "error";

export interface NewsTopic {
  id: number;
  project: string;
  name: string;
  description: string;
  agent: string;
  terms: string[];
  updateCron: string;
  renewTermsCron: string | null;
  alwaysRegenerateTerms: boolean;
  maxItemsPerRun: number;
  enabled: boolean;
  runStatus: NewsRunStatus;
  nextUpdateAt: number;
  nextRenewTermsAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: NewsLastRunStatus | null;
  lastRunError: string | null;
  lastSessionId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewsItem {
  id: number;
  topicId: number;
  project: string;
  title: string;
  summary: string;
  url: string | null;
  imageUrl: string | null;
  source: string | null;
  publishedAt: number | null;
  contentHash: string;
  seenCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
}

export interface NewsTopicInput {
  name: string;
  description?: string;
  agent: string;
  terms?: string[];
  updateCron: string;
  renewTermsCron?: string | null;
  alwaysRegenerateTerms?: boolean;
  maxItemsPerRun?: number;
  enabled?: boolean;
}

export async function fetchNewsTopics(project: string): Promise<NewsTopic[]> {
  const data = await jsonFetch<{ topics: NewsTopic[] }>(
    `/api/projects/${encodeURIComponent(project)}/news/topics`,
  );
  return data.topics;
}

export async function createNewsTopic(
  project: string,
  input: NewsTopicInput,
): Promise<NewsTopic> {
  const data = await jsonFetch<{ topic: NewsTopic }>(
    `/api/projects/${encodeURIComponent(project)}/news/topics`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.topic;
}

export async function updateNewsTopic(
  project: string,
  id: number,
  patch: Partial<NewsTopicInput>,
): Promise<NewsTopic> {
  const data = await jsonFetch<{ topic: NewsTopic }>(
    `/api/projects/${encodeURIComponent(project)}/news/topics/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.topic;
}

export async function deleteNewsTopic(project: string, id: number): Promise<void> {
  await jsonFetch(
    `/api/projects/${encodeURIComponent(project)}/news/topics/${id}`,
    { method: "DELETE" },
  );
}

export async function runNewsTopicNow(project: string, id: number): Promise<void> {
  await jsonFetch(
    `/api/projects/${encodeURIComponent(project)}/news/topics/${id}/run-now`,
    { method: "POST" },
  );
}

export async function regenerateNewsTopicTerms(
  project: string,
  id: number,
): Promise<void> {
  await jsonFetch(
    `/api/projects/${encodeURIComponent(project)}/news/topics/${id}/regenerate-terms`,
    { method: "POST" },
  );
}

export async function fetchNewsItems(
  project: string,
  opts?: { topicId?: number; limit?: number; since?: number },
): Promise<NewsItem[]> {
  const params = new URLSearchParams();
  if (opts?.topicId !== undefined) params.set("topicId", String(opts.topicId));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.since !== undefined) params.set("since", String(opts.since));
  const qs = params.toString();
  const data = await jsonFetch<{ items: NewsItem[] }>(
    `/api/projects/${encodeURIComponent(project)}/news/items${qs ? `?${qs}` : ""}`,
  );
  return data.items;
}

export async function deleteNewsItem(project: string, id: number): Promise<void> {
  await jsonFetch(
    `/api/projects/${encodeURIComponent(project)}/news/items/${id}`,
    { method: "DELETE" },
  );
}
