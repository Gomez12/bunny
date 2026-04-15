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
import { errorMessage } from "../util/error.ts";
import { json } from "./http.ts";
import { canSeeProject } from "./routes.ts";
import { getProject, validateProjectName } from "../memory/projects.ts";
import {
  listSwimlanes,
  seedDefaultSwimlanes,
  type Swimlane,
} from "../memory/board_swimlanes.ts";
import { getCard, listCards, type Card } from "../memory/board_cards.ts";
import { listRunsForCard, type CardRun } from "../memory/board_runs.ts";

export interface BoardRouteCtx {
  db: Database;
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

  const cardMatch = pathname.match(/^\/api\/cards\/(\d+)$/);
  if (cardMatch) {
    const id = Number(cardMatch[1]);
    if (req.method === "GET") return handleGetCard(ctx, user, id);
  }

  const runsMatch = pathname.match(/^\/api\/cards\/(\d+)\/runs$/);
  if (runsMatch) {
    const id = Number(runsMatch[1]);
    if (req.method === "GET") return handleListRuns(ctx, user, id);
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
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
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

function handleGetBoard(ctx: BoardRouteCtx, user: User, rawProject: string): Response {
  let project: string;
  try {
    project = validateProjectName(rawProject);
  } catch (e) {
    return json({ error: errorMessage(e) }, 400);
  }
  const p = getProject(ctx.db, project);
  if (!p) return json({ error: "project not found" }, 404);
  if (!canSeeProject(p, user)) return json({ error: "forbidden" }, 403);

  // Backfill default lanes for legacy projects that never had any.
  seedDefaultSwimlanes(ctx.db, project);

  const swimlanes = listSwimlanes(ctx.db, project).map(toSwimlaneDto);
  const cards = listCards(ctx.db, project).map(toCardDto);
  return json({ project, swimlanes, cards });
}

function handleGetCard(ctx: BoardRouteCtx, user: User, id: number): Response {
  const card = getCard(ctx.db, id);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const runs = listRunsForCard(ctx.db, id).map(toRunDto);
  return json({ card: toCardDto(card), runs });
}

function handleListRuns(ctx: BoardRouteCtx, user: User, cardId: number): Response {
  const card = getCard(ctx.db, cardId);
  if (!card) return json({ error: "not found" }, 404);
  const p = getProject(ctx.db, card.project);
  if (!p || !canSeeProject(p, user)) return json({ error: "forbidden" }, 403);
  const runs = listRunsForCard(ctx.db, cardId).map(toRunDto);
  return json({ runs });
}
