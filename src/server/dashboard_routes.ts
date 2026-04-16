import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import { getDashboardStats } from "../memory/stats.ts";
import { json } from "./http.ts";

export interface DashboardRouteCtx {
  db: Database;
}

const RANGES: Record<string, { offsetMs: number; bucketMs: number }> = {
  "24h": { offsetMs: 24 * 60 * 60 * 1000, bucketMs: 3_600_000 },
  "7d": { offsetMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 21_600_000 },
  "30d": { offsetMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 86_400_000 },
  "90d": { offsetMs: 90 * 24 * 60 * 60 * 1000, bucketMs: 259_200_000 },
  all: { offsetMs: 0, bucketMs: 604_800_000 },
};

export function handleDashboardRoute(
  req: Request,
  url: URL,
  ctx: DashboardRouteCtx,
  user: User,
): Response | null {
  if (url.pathname !== "/api/dashboard" || req.method !== "GET") return null;

  const rangeKey = url.searchParams.get("range") ?? "7d";
  const range = RANGES[rangeKey];
  if (!range) return json({ error: `invalid range '${rangeKey}'` }, 400);

  const now = Date.now();
  const fromTs = range.offsetMs === 0 ? 0 : now - range.offsetMs;
  const userId = user.role !== "admin" ? user.id : undefined;

  const data = getDashboardStats(ctx.db, { fromTs, bucketMs: range.bucketMs, userId });
  return json(data);
}
