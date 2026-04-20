import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json, readJson } from "./http.ts";
import { canSeeProject, canEditProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import type { Project } from "../memory/projects.ts";
import {
  setSessionHiddenFromChat,
  setSessionQuickChat,
} from "../memory/session_visibility.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  controllerSink,
  finishSse,
} from "../agent/render_sse.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { resolvePrompt } from "../prompts/resolve.ts";
import {
  bulkCreateContacts,
  canEditContact,
  contactsToVCard,
  contactToVCard,
  createContact,
  createGroup,
  deleteContact,
  deleteGroup,
  getContact,
  getGroup,
  listContacts,
  listGroups,
  updateContact,
  updateGroup,
  type CreateContactOpts,
} from "../memory/contacts.ts";

export interface ContactRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleContactRoute(
  req: Request,
  url: URL,
  ctx: ContactRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // ── Contact groups ───────────────────────────────────────────────────────
  const groupsListMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contact-groups$/,
  );
  if (groupsListMatch) {
    const project = decodeURIComponent(groupsListMatch[1]!);
    if (req.method === "GET") return handleListGroups(ctx, user, project);
    if (req.method === "POST")
      return handleCreateGroup(req, ctx, user, project);
  }

  const groupIdMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contact-groups\/(\d+)$/,
  );
  if (groupIdMatch) {
    const project = decodeURIComponent(groupIdMatch[1]!);
    const id = Number(groupIdMatch[2]);
    if (req.method === "PATCH")
      return handlePatchGroup(req, ctx, user, project, id);
    if (req.method === "DELETE")
      return handleDeleteGroup(ctx, user, project, id);
  }

  // ── Contacts list / create / import / export / edit / ask ────────────────
  const contactsListMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contacts$/,
  );
  if (contactsListMatch) {
    const project = decodeURIComponent(contactsListMatch[1]!);
    if (req.method === "GET") return handleList(ctx, user, project, url);
    if (req.method === "POST") return handleCreate(req, ctx, user, project);
  }

  const importMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contacts\/import$/,
  );
  if (importMatch) {
    const project = decodeURIComponent(importMatch[1]!);
    if (req.method === "POST") return handleImport(req, ctx, user, project);
  }

  const exportMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contacts\/export$/,
  );
  if (exportMatch) {
    const project = decodeURIComponent(exportMatch[1]!);
    if (req.method === "POST") return handleExport(req, ctx, user, project);
  }

  const editMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contacts\/edit$/,
  );
  if (editMatch) {
    const project = decodeURIComponent(editMatch[1]!);
    if (req.method === "POST") return handleEdit(req, ctx, user, project);
  }

  const askMatch = pathname.match(/^\/api\/projects\/([^/]+)\/contacts\/ask$/);
  if (askMatch) {
    const project = decodeURIComponent(askMatch[1]!);
    if (req.method === "POST") return handleAsk(req, ctx, user, project);
  }

  // ── Single contact + vcf export ─────────────────────────────────────────
  const vcfMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contacts\/(\d+)\/vcf$/,
  );
  if (vcfMatch) {
    const project = decodeURIComponent(vcfMatch[1]!);
    const id = Number(vcfMatch[2]);
    if (req.method === "GET") return handleVcfExport(ctx, user, project, id);
  }

  const contactIdMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/contacts\/(\d+)$/,
  );
  if (contactIdMatch) {
    const project = decodeURIComponent(contactIdMatch[1]!);
    const id = Number(contactIdMatch[2]);
    if (req.method === "GET") return handleGet(ctx, user, project, id);
    if (req.method === "PATCH") return handlePatch(req, ctx, user, project, id);
    if (req.method === "DELETE") return handleDelete(ctx, user, project, id);
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type ResolveOk = { ok: true; project: string; p: Project };
type ResolveErr = { ok: false; error: Response };
type ResolveResult = ResolveOk | ResolveErr;

function resolveProject(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): ResolveResult {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return { ok: false, error: json({ error: errorMessage(e) }, 400) };
  }
  const p = getProject(ctx.db, project);
  if (!p)
    return { ok: false, error: json({ error: "project not found" }, 404) };
  if (!canSeeProject(p, user))
    return { ok: false, error: json({ error: "forbidden" }, 403) };
  return { ok: true, project, p };
}

// ── Contact handlers ─────────────────────────────────────────────────────────

function handleList(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  url: URL,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const search = url.searchParams.get("q") || undefined;
  const groupId = url.searchParams.has("group")
    ? Number(url.searchParams.get("group"))
    : undefined;
  const limit = url.searchParams.has("limit")
    ? Number(url.searchParams.get("limit"))
    : undefined;
  const offset = url.searchParams.has("offset")
    ? Number(url.searchParams.get("offset"))
    : undefined;

  const result = listContacts(ctx.db, r.project, {
    search,
    groupId,
    limit,
    offset,
  });
  return json(result);
}

async function handleCreate(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<Partial<CreateContactOpts>>(req);
  if (!body?.name?.trim()) return json({ error: "missing name" }, 400);

  try {
    const contact = createContact(ctx.db, {
      ...body,
      project: r.project,
      name: body.name,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "contact",
      kind: "create",
      userId: user.id,
      data: { id: contact.id, project: r.project },
    });
    return json({ contact }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleGet(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const contact = getContact(ctx.db, id);
  if (!contact || contact.project !== r.project)
    return json({ error: "not found" }, 404);
  return json({ contact });
}

async function handlePatch(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const contact = getContact(ctx.db, id);
  if (!contact || contact.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!canEditContact(user, contact, r.p))
    return json({ error: "forbidden" }, 403);

  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateContact(ctx.db, id, body);
    void ctx.queue.log({
      topic: "contact",
      kind: "update",
      userId: user.id,
      data: { id, project: r.project },
    });
    return json({ contact: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDelete(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const contact = getContact(ctx.db, id);
  if (!contact || contact.project !== r.project)
    return json({ error: "not found" }, 404);
  if (!canEditContact(user, contact, r.p))
    return json({ error: "forbidden" }, 403);

  deleteContact(ctx.db, id, user.id);
  void ctx.queue.log({
    topic: "contact",
    kind: "delete",
    userId: user.id,
    data: { id, project: r.project, soft: true },
  });
  return json({ ok: true });
}

async function handleImport(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{
    contacts?: Omit<CreateContactOpts, "project" | "createdBy">[];
  }>(req);
  if (!body?.contacts?.length)
    return json({ error: "missing contacts array" }, 400);

  try {
    const imported = bulkCreateContacts(
      ctx.db,
      r.project,
      body.contacts,
      user.id,
    );
    void ctx.queue.log({
      topic: "contact",
      kind: "import",
      userId: user.id,
      data: { project: r.project, count: imported },
    });
    return json({ imported }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleVcfExport(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const contact = getContact(ctx.db, id);
  if (!contact || contact.project !== r.project)
    return json({ error: "not found" }, 404);

  const vcf = contactToVCard(contact);
  const safeName = contact.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return new Response(vcf, {
    headers: {
      "Content-Type": "text/vcard",
      "Content-Disposition": `attachment; filename="${safeName}.vcf"`,
    },
  });
}

async function handleExport(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{ ids?: number[] }>(req);
  if (!body?.ids?.length) return json({ error: "missing ids array" }, 400);

  const result = listContacts(ctx.db, r.project);
  const idSet = new Set(body.ids);
  const contacts = result.contacts.filter((c) => idSet.has(c.id));

  const vcf = contactsToVCard(contacts);
  return new Response(vcf, {
    headers: {
      "Content-Type": "text/vcard",
      "Content-Disposition": `attachment; filename="contacts.vcf"`,
    },
  });
}

// ── Group handlers ───────────────────────────────────────────────────────────

function handleListGroups(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;
  return json({ groups: listGroups(ctx.db, r.project) });
}

async function handleCreateGroup(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{ name?: string; color?: string }>(req);
  if (!body?.name?.trim()) return json({ error: "missing name" }, 400);

  try {
    const group = createGroup(ctx.db, {
      project: r.project,
      name: body.name,
      color: body.color,
      createdBy: user.id,
    });
    void ctx.queue.log({
      topic: "contact",
      kind: "group.create",
      userId: user.id,
      data: { id: group.id, project: r.project, name: group.name },
    });
    return json({ group }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handlePatchGroup(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const group = getGroup(ctx.db, id);
  if (!group || group.project !== r.project)
    return json({ error: "not found" }, 404);

  const body = await readJson<{ name?: string; color?: string | null }>(req);
  if (!body) return json({ error: "invalid json" }, 400);

  try {
    const updated = updateGroup(ctx.db, id, body);
    void ctx.queue.log({
      topic: "contact",
      kind: "group.update",
      userId: user.id,
      data: { id, project: r.project },
    });
    return json({ group: updated });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDeleteGroup(
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
  id: number,
): Response {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const group = getGroup(ctx.db, id);
  if (!group || group.project !== r.project)
    return json({ error: "not found" }, 404);

  deleteGroup(ctx.db, id);
  void ctx.queue.log({
    topic: "contact",
    kind: "group.delete",
    userId: user.id,
    data: { id, project: r.project, name: group.name },
  });
  return json({ ok: true });
}

// ── Edit mode (agent loop) ───────────────────────────────────────────────────


async function handleEdit(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{ prompt?: string; contactsSummary?: string }>(
    req,
  );
  if (!body) return json({ error: "invalid json" }, 400);
  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  const contactsSummary = body.contactsSummary ?? "";
  const sessionId = `contact-edit-${randomUUID()}`;
  const userPrompt = contactsSummary
    ? `Current contacts:\n${contactsSummary}\n\nInstruction: ${prompt}`
    : prompt;

  setSessionHiddenFromChat(ctx.db, user.id, sessionId, true);

  void ctx.queue.log({
    topic: "contact",
    kind: "edit",
    userId: user.id,
    data: { project: r.project, prompt },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = controllerSink(controller);
      const renderer = createSseRenderer(sink);
      try {
        await runAgent({
          prompt: userPrompt,
          sessionId,
          userId: user.id,
          project: r.project,
          llmCfg: ctx.cfg.llm,
          embedCfg: ctx.cfg.embed,
          memoryCfg: ctx.cfg.memory,
          agentCfg: ctx.cfg.agent,
          webCfg: ctx.cfg.web,
          tools: toolsRegistry,
          db: ctx.db,
          queue: ctx.queue,
          renderer,
          systemPromptOverride: resolvePrompt("contact.edit", {
            project: r.project,
          }),
        });
      } catch (e) {
        renderer.onError(errorMessage(e));
      } finally {
        finishSse(sink);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Session-Id": sessionId,
    },
  });
}

// ── Question mode ────────────────────────────────────────────────────────────

async function handleAsk(
  req: Request,
  ctx: ContactRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const r = resolveProject(ctx, user, rawProject);
  if (!r.ok) return r.error;

  const body = await readJson<{ prompt?: string; contactsSummary?: string }>(
    req,
  );
  if (!body) return json({ error: "invalid json" }, 400);
  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "missing prompt" }, 400);

  const contactsSummary = body.contactsSummary ?? "";
  const sessionId = randomUUID();

  const fullPrompt = contactsSummary
    ? `[Contacts Summary]\n\n${contactsSummary}\n\n${prompt}`
    : prompt;

  setSessionQuickChat(ctx.db, user.id, sessionId, true);

  void ctx.queue.log({
    topic: "contact",
    kind: "ask",
    userId: user.id,
    data: { project: r.project, prompt, sessionId },
  });

  return json({
    sessionId,
    project: r.project,
    prompt: fullPrompt,
    isQuickChat: true,
  });
}
