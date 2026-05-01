/**
 * HTTP routes for the per-project kanban board.
 *
 * Mounted from `routes.ts:handleApi` between agent-routes and the generic
 * project endpoints. Read-only endpoints (PR 2):
 *   - GET /api/projects/:project/board   →  { swimlanes, cards }
 *   - GET /api/cards/:id                  →  { card, runs }
 *   - GET /api/cards/:id/runs             →  { runs }
 *
 * The board GET also seeds the default Todo/Doing/Done lanes if a legacy
 * project never had any (idempotent backfill — `createProject` already seeds
 * for new projects).
 */

import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";
import { canEditProject, canSeeProject } from "./routes.ts";
import { requireProjectAccess } from "./route_helpers.ts";
import { runCard, subscribeToRun, getRunFanout } from "../board/run_card.ts";
import { getRun } from "../memory/board_runs.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { controllerSink, finishSse } from "../agent/render_sse.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import {
  createSwimlane,
  deleteSwimlane,
  getSwimlane,
  listSwimlanes,
  seedDefaultSwimlanes,
  updateSwimlane,
  type Swimlane,
} from "../memory/board_swimlanes.ts";
import {
  archiveCard,
  canEditCard,
  createCard,
  getCard,
  listCards,
  moveCard,
  updateCard,
  type Card,
} from "../memory/board_cards.ts";
import { listRunsForCard, type CardRun } from "../memory/board_runs.ts";
import { isAgentLinkedToProject } from "../memory/agents.ts";

export interface BoardRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

export async function handleBoardRoute(
  req: Request,
  url: URL,
  ctx: BoardRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  const boardMatch = pathname.match(/^\/api\/projects\/([^/]+)\/board$/);
  if (boardMatch) {
    if (req.method !== "GET") return null;
    return handleGetBoard(ctx, user, decodeURIComponent(boardMatch[1]!));
  }

  const swimlanesMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/swimlanes$/,
  );
  if (swimlanesMatch) {
    const project = decodeURIComponent(swimlanesMatch[1]!);
    if (req.method === "POST")
      return handleCreateSwimlane(req, ctx, user, project);
  }

  const swimlaneMatch = pathname.match(/^\/api\/swimlanes\/(\d+)$/);
  if (swimlaneMatch) {
    const id = Number(swimlaneMatch[1]);
    if (req.method === "PATCH") return handlePatchSwimlane(req, ctx, user, id);
    if (req.method === "DELETE") return handleDeleteSwimlane(ctx, user, id);
  }

  const cardsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/cards$/);
  if (cardsMatch) {
    const project = decodeURIComponent(cardsMatch[1]!);
    if (req.method === "POST") return handleCreateCard(req, ctx, user, project);
  }

  const cardMatch = pathname.match(/^\/api\/cards\/(\d+)$/);
  if (cardMatch) {
    const id = Number(cardMatch[1]);
    if (req.method === "GET") return handleGetCard(ctx, user, id);
    if (req.method === "PATCH") return handlePatchCard(req, ctx, user, id);
    if (req.method === "DELETE") return handleArchiveCard(ctx, user, id);
  }

  const moveMatch = pathname.match(/^\/api\/cards\/(\d+)\/move$/);
  if (moveMatch) {
    const id = Number(moveMatch[1]);
    if (req.method === "POST") return handleMoveCard(req, ctx, user, id);
  }

  const runsMatch = pathname.match(/^\/api\/cards\/(\d+)\/runs$/);
  if (runsMatch) {
    const id = Number(runsMatch[1]);
    if (req.method === "GET") return handleListRuns(ctx, user, id);
  }

  const runMatch = pathname.match(/^\/api\/cards\/(\d+)\/run$/);
  if (runMatch) {
    const id = Number(runMatch[1]);
    if (req.method === "POST") return handleRunCard(req, ctx, user, id);
  }

  const streamMatch = pathname.match(
    /^\/api\/cards\/(\d+)\/runs\/(\d+)\/stream$/,
  );
  if (streamMatch) {
    const cardId = Number(streamMatch[1]);
    const runId = Number(streamMatch[2]);
    if (req.method === "GET") return handleStreamRun(ctx, user, cardId, runId);
  }

  return null;
}

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface SwimlaneDto {
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

export interface CardDto {
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
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Most recent run status (computed), or null when the card has never run. */
  latestRunStatus?: "queued" | "running" | "done" | "error" | null;
}

export interface CardRunDto {
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

export function toSwimlaneDto(s: Swimlane): SwimlaneDto {
  return { ...s };
}
export function toCardDto(c: Card): CardDto {
  return { ...c };
}
export function toRunDto(r: CardRun): CardRunDto {
  return { ...r };
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleGetBoard(
  ctx: BoardRouteCtx,
  user: User,
  rawProject: string,
): Response {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  const { project } = access;

  // Backfill default lanes for legacy projects that never had any.
  seedDefaultSwimlanes(ctx.db, project);

  const swimlanes = listSwimlanes(ctx.db, project).map(toSwimlaneDto);
  const latestRuns = latestRunStatusByCard(ctx.db, project);
  const cards = listCards(ctx.db, project).map((c) => ({
    ...toCardDto(c),
    latestRunStatus: latestRuns.get(c.id) ?? null,
  }));
  return json({ project, swimlanes, cards });
}

/** Map card-id → status of its most recent run. */
function latestRunStatusByCard(
  db: Database,
  project: string,
): Map<number, "queued" | "running" | "done" | "error"> {
  const rows = db
    .prepare(
      `SELECT r.card_id AS card_id, r.status AS status
         FROM board_card_runs r
        WHERE r.id IN (
            SELECT MAX(r2.id)
              FROM board_card_runs r2
              JOIN board_cards c2 ON c2.id = r2.card_id
             WHERE c2.project = ?
             GROUP BY r2.card_id
          )`,
    )
    .all(project) as Array<{ card_id: number; status: string }>;
  const map = new Map<number, "queued" | "running" | "done" | "error">();
  for (const r of rows)
    map.set(r.card_id, r.status as "queued" | "running" | "done" | "error");
  return map;
}

function handleGetCard(ctx: BoardRouteCtx, user: User, id: number): Response {
  const card = getCard(ctx.db, id);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const runs = listRunsForCard(ctx.db, id).map(toRunDto);
  return json({ card: toCardDto(card), runs });
}

function handleListRuns(
  ctx: BoardRouteCtx,
  user: User,
  cardId: number,
): Response {
  const card = getCard(ctx.db, cardId);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const runs = listRunsForCard(ctx.db, cardId).map(toRunDto);
  return json({ runs });
}

// ── Write handlers ────────────────────────────────────────────────────────

interface SwimlaneBody {
  name?: string;
  position?: number;
  wipLimit?: number | null;
  autoRun?: boolean;
  defaultAssigneeUserId?: string | null;
  defaultAssigneeAgent?: string | null;
  nextSwimlaneId?: number | null;
  color?: string | null;
  group?: string | null;
}

async function handleCreateSwimlane(
  req: Request,
  ctx: BoardRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const access = requireProjectAccess(ctx.db, user, rawProject, "edit");
  if (!access.ok) return access.response;
  const { project } = access;
  const body = (await readJson<SwimlaneBody>(req)) ?? {};
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "missing name" }, 400);
  const defAgent = body.defaultAssigneeAgent?.trim() || null;
  const defUser = body.defaultAssigneeUserId?.trim() || null;
  if (defAgent && defUser)
    return json(
      { error: "default assignee must be either a user or an agent, not both" },
      400,
    );
  if (defAgent && !isAgentLinkedToProject(ctx.db, project, defAgent)) {
    return json(
      { error: `agent '${defAgent}' is not available in project` },
      400,
    );
  }
  if (body.nextSwimlaneId != null) {
    const target = getSwimlane(ctx.db, body.nextSwimlaneId);
    if (!target || target.project !== project)
      return json({ error: "next swimlane not found in this project" }, 400);
  }
  try {
    const lane = createSwimlane(ctx.db, {
      project,
      name,
      position: body.position,
      wipLimit: body.wipLimit ?? null,
      autoRun: body.autoRun === true,
      defaultAssigneeUserId: defUser,
      defaultAssigneeAgent: defAgent,
      nextSwimlaneId: body.nextSwimlaneId ?? null,
      color: body.color ?? null,
      group: body.group ?? null,
    });
    void ctx.queue.log({
      topic: "board",
      kind: "swimlane.create",
      userId: user.id,
      data: {
        project,
        name,
        id: lane.id,
        wipLimit: body.wipLimit ?? null,
        autoRun: body.autoRun === true,
        color: body.color ?? null,
        group: body.group ?? null,
      },
    });
    return json({ swimlane: toSwimlaneDto(lane) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handlePatchSwimlane(
  req: Request,
  ctx: BoardRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const lane = getSwimlane(ctx.db, id);
  if (!lane) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, lane.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  const body = (await readJson<SwimlaneBody>(req)) ?? {};
  const defAgent =
    body.defaultAssigneeAgent === undefined
      ? undefined
      : body.defaultAssigneeAgent?.trim() || null;
  const defUser =
    body.defaultAssigneeUserId === undefined
      ? undefined
      : body.defaultAssigneeUserId?.trim() || null;
  const resolvedAgent =
    defAgent === undefined ? lane.defaultAssigneeAgent : defAgent;
  const resolvedUser =
    defUser === undefined ? lane.defaultAssigneeUserId : defUser;
  if (resolvedAgent && resolvedUser)
    return json(
      { error: "default assignee must be either a user or an agent, not both" },
      400,
    );
  if (
    resolvedAgent &&
    !isAgentLinkedToProject(ctx.db, lane.project, resolvedAgent)
  ) {
    return json(
      { error: `agent '${resolvedAgent}' is not available in project` },
      400,
    );
  }
  if (body.nextSwimlaneId !== undefined && body.nextSwimlaneId != null) {
    const target = getSwimlane(ctx.db, body.nextSwimlaneId);
    if (!target || target.project !== lane.project)
      return json({ error: "next swimlane not found in this project" }, 400);
    if (target.id === id)
      return json({ error: "next swimlane cannot be the lane itself" }, 400);
  }
  try {
    const updated = updateSwimlane(ctx.db, id, {
      name: body.name,
      position: body.position,
      wipLimit: body.wipLimit,
      autoRun: body.autoRun,
      defaultAssigneeUserId: defUser,
      defaultAssigneeAgent: defAgent,
      nextSwimlaneId: body.nextSwimlaneId,
      color: body.color,
      group: body.group,
    });
    const changed = Object.keys(body).filter(
      (k) => (body as Record<string, unknown>)[k] !== undefined,
    );
    void ctx.queue.log({
      topic: "board",
      kind: "swimlane.update",
      userId: user.id,
      data: { id, project: lane.project, changed },
    });
    return json({ swimlane: toSwimlaneDto(updated) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleDeleteSwimlane(
  ctx: BoardRouteCtx,
  user: User,
  id: number,
): Response {
  const lane = getSwimlane(ctx.db, id);
  if (!lane) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, lane.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditProject(p, user)) return json({ error: "forbidden" }, 403);
  try {
    deleteSwimlane(ctx.db, id);
    void ctx.queue.log({
      topic: "board",
      kind: "swimlane.delete",
      userId: user.id,
      data: { id, project: lane.project },
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

interface CardBody {
  swimlaneId?: number;
  title?: string;
  description?: string;
  assigneeUserId?: string | null;
  assigneeAgent?: string | null;
  autoRun?: boolean;
  estimateHours?: number | null;
  percentDone?: number | null;
  position?: number;
}

async function handleCreateCard(
  req: Request,
  ctx: BoardRouteCtx,
  user: User,
  rawProject: string,
): Promise<Response> {
  const access = requireProjectAccess(ctx.db, user, rawProject, "view");
  if (!access.ok) return access.response;
  const { project } = access;

  const body = (await readJson<CardBody>(req)) ?? {};
  if (!body.swimlaneId) return json({ error: "missing swimlaneId" }, 400);
  if (!body.title || !body.title.trim())
    return json({ error: "missing title" }, 400);

  const lane = getSwimlane(ctx.db, body.swimlaneId);
  if (!lane || lane.project !== project) {
    return json({ error: "swimlane does not belong to project" }, 400);
  }

  const hasExplicitAssignee =
    body.assigneeUserId != null || body.assigneeAgent != null;
  const assigneeUserId =
    body.assigneeUserId ??
    (!hasExplicitAssignee ? lane.defaultAssigneeUserId : null) ??
    null;
  const assigneeAgent =
    (body.assigneeAgent?.trim() ||
      (!hasExplicitAssignee ? lane.defaultAssigneeAgent : null)) ??
    null;
  if (
    assigneeAgent &&
    !isAgentLinkedToProject(ctx.db, project, assigneeAgent)
  ) {
    return json(
      { error: `agent '${assigneeAgent}' is not available in project` },
      400,
    );
  }

  try {
    const card = createCard(ctx.db, {
      project,
      swimlaneId: body.swimlaneId,
      title: body.title,
      description: body.description ?? "",
      assigneeUserId,
      assigneeAgent,
      autoRun: body.autoRun,
      estimateHours: body.estimateHours,
      percentDone: body.percentDone,
      createdBy: user.id,
      position: body.position,
    });
    void ctx.queue.log({
      topic: "board",
      kind: "card.create",
      userId: user.id,
      data: {
        project,
        id: card.id,
        title: body.title,
        swimlaneId: body.swimlaneId,
        assigneeUserId,
        assigneeAgent,
        autoRun: card.autoRun,
      },
    });
    return json({ card: toCardDto(card) }, 201);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

async function handlePatchCard(
  req: Request,
  ctx: BoardRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const card = getCard(ctx.db, id);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCard(user, card, p)) return json({ error: "forbidden" }, 403);

  const body = (await readJson<CardBody>(req)) ?? {};

  if (body.swimlaneId !== undefined) {
    const lane = getSwimlane(ctx.db, body.swimlaneId);
    if (!lane || lane.project !== card.project) {
      return json({ error: "swimlane does not belong to project" }, 400);
    }
  }
  if (
    body.assigneeAgent &&
    !isAgentLinkedToProject(ctx.db, card.project, body.assigneeAgent)
  ) {
    return json(
      { error: `agent '${body.assigneeAgent}' is not available in project` },
      400,
    );
  }

  try {
    const updated = updateCard(ctx.db, id, {
      title: body.title,
      description: body.description,
      assigneeUserId: body.assigneeUserId,
      assigneeAgent: body.assigneeAgent,
      autoRun: body.autoRun,
      estimateHours: body.estimateHours,
      percentDone: body.percentDone,
      swimlaneId: body.swimlaneId,
      position: body.position,
    });
    const changed = Object.keys(body).filter(
      (k) => (body as Record<string, unknown>)[k] !== undefined,
    );
    void ctx.queue.log({
      topic: "board",
      kind: "card.update",
      userId: user.id,
      data: { id, project: card.project, changed },
    });
    return json({ card: toCardDto(updated) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

interface MoveBody {
  swimlaneId?: number;
  beforeCardId?: number;
  afterCardId?: number;
  position?: number;
}

async function handleMoveCard(
  req: Request,
  ctx: BoardRouteCtx,
  user: User,
  id: number,
): Promise<Response> {
  const card = getCard(ctx.db, id);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCard(user, card, p)) return json({ error: "forbidden" }, 403);

  const body = (await readJson<MoveBody>(req)) ?? {};
  const swimlaneId = body.swimlaneId ?? card.swimlaneId;
  const lane = getSwimlane(ctx.db, swimlaneId);
  if (!lane || lane.project !== card.project) {
    return json({ error: "swimlane does not belong to project" }, 400);
  }

  try {
    let moved = moveCard(ctx.db, id, {
      swimlaneId,
      beforeCardId: body.beforeCardId,
      afterCardId: body.afterCardId,
      position: body.position,
    });
    if (
      swimlaneId !== card.swimlaneId &&
      !card.assigneeUserId &&
      !card.assigneeAgent
    ) {
      if (lane.defaultAssigneeUserId || lane.defaultAssigneeAgent) {
        moved = updateCard(ctx.db, id, {
          assigneeUserId: lane.defaultAssigneeUserId,
          assigneeAgent: lane.defaultAssigneeAgent,
        });
      }
    }
    void ctx.queue.log({
      topic: "board",
      kind: "card.move",
      userId: user.id,
      data: {
        id,
        project: card.project,
        fromSwimlaneId: card.swimlaneId,
        toSwimlaneId: swimlaneId,
      },
    });
    return json({ card: toCardDto(moved) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleArchiveCard(
  ctx: BoardRouteCtx,
  user: User,
  id: number,
): Response {
  const card = getCard(ctx.db, id);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCard(user, card, p)) return json({ error: "forbidden" }, 403);
  archiveCard(ctx.db, id);
  void ctx.queue.log({
    topic: "board",
    kind: "card.archive",
    userId: user.id,
    data: { id, project: card.project },
  });
  return json({ ok: true });
}

// ── Run flow ──────────────────────────────────────────────────────────────

interface RunBody {
  agent?: string;
  sessionId?: string;
}

async function handleRunCard(
  req: Request,
  ctx: BoardRouteCtx,
  user: User,
  cardId: number,
): Promise<Response> {
  const card = getCard(ctx.db, cardId);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canEditCard(user, card, p)) return json({ error: "forbidden" }, 403);

  const body = (await readJson<RunBody>(req)) ?? {};
  const agent = body.agent?.trim() || card.assigneeAgent;
  if (!agent) return json({ error: "card has no agent assigned" }, 400);

  try {
    const { run, sessionId } = await runCard({
      db: ctx.db,
      queue: ctx.queue,
      cfg: ctx.cfg,
      tools: toolsRegistry,
      cardId,
      agent,
      triggeredBy: user.id,
      triggerKind: "manual",
      sessionId: body.sessionId,
    });
    return json({ run: toRunDto(run), sessionId }, 202);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
}

function handleStreamRun(
  ctx: BoardRouteCtx,
  user: User,
  cardId: number,
  runId: number,
): Response {
  const card = getCard(ctx.db, cardId);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const run = getRun(ctx.db, runId);
  if (!run || run.cardId !== cardId) return json({ error: "not found" }, 404);

  const fan = getRunFanout(runId);
  // Run already finished and the in-memory fanout has been dropped — caller
  // should fall back to GET /api/sessions/:id/messages.
  if (!fan) return json({ error: "run already completed" }, 409);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink = controllerSink(controller);
      const unsubscribe = subscribeToRun(runId, sink);
      // If subscribeToRun closed the sink (run already finished while we were
      // setting up), cap with a `done` event and close.
      if (fan.closed) finishSse(sink);
      // Hook into stream cancellation via the controller's signal would be
      // ideal; a cleanup interval is overkill — closing the underlying sink
      // happens automatically when the run finishes (subscribers cleared).
      void unsubscribe;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
