/**
 * Web News — per-project periodic news aggregator.
 *
 * Two tables:
 *   - `web_news_topics` — per-project topic rows with their own update cron,
 *     optional renew-terms cron, agent, search terms (JSON) and self-scheduling
 *     `next_update_at` / `next_renew_terms_at` timestamps.
 *   - `web_news_items` — append-only news items deduplicated per topic by
 *     `content_hash = sha256(normalizedUrl + normalizedTitle)`. A re-run that
 *     finds an already-known story bumps `seen_count` + `last_seen_at`.
 *
 * See ADR 0024.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { User } from "../auth/users.ts";
import type { Project } from "./projects.ts";

export type RunStatus = "idle" | "running";
export type LastRunStatus = "ok" | "error";

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
  runStatus: RunStatus;
  nextUpdateAt: number;
  nextRenewTermsAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: LastRunStatus | null;
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

interface TopicRow {
  id: number;
  project: string;
  name: string;
  description: string;
  agent: string;
  terms: string;
  update_cron: string;
  renew_terms_cron: string | null;
  always_regenerate_terms: number;
  max_items_per_run: number;
  enabled: number;
  run_status: string;
  next_update_at: number;
  next_renew_terms_at: number | null;
  last_run_at: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_session_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: number;
  topic_id: number;
  project: string;
  title: string;
  summary: string;
  url: string | null;
  image_url: string | null;
  source: string | null;
  published_at: number | null;
  content_hash: string;
  seen_count: number;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
}

const TOPIC_COLS = `id, project, name, description, agent, terms,
                    update_cron, renew_terms_cron, always_regenerate_terms,
                    max_items_per_run, enabled, run_status,
                    next_update_at, next_renew_terms_at,
                    last_run_at, last_run_status, last_run_error, last_session_id,
                    created_by, created_at, updated_at`;

const ITEM_COLS = `id, topic_id, project, title, summary, url, image_url, source,
                   published_at, content_hash, seen_count,
                   first_seen_at, last_seen_at, created_at`;

function parseTerms(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function normaliseRunStatus(raw: string): RunStatus {
  return raw === "running" ? "running" : "idle";
}

function normaliseLastStatus(raw: string | null): LastRunStatus | null {
  if (raw === "ok" || raw === "error") return raw;
  return null;
}

function rowToTopic(r: TopicRow): NewsTopic {
  return {
    id: r.id,
    project: r.project,
    name: r.name,
    description: r.description,
    agent: r.agent,
    terms: parseTerms(r.terms),
    updateCron: r.update_cron,
    renewTermsCron: r.renew_terms_cron,
    alwaysRegenerateTerms: r.always_regenerate_terms !== 0,
    maxItemsPerRun: r.max_items_per_run,
    enabled: r.enabled !== 0,
    runStatus: normaliseRunStatus(r.run_status),
    nextUpdateAt: r.next_update_at,
    nextRenewTermsAt: r.next_renew_terms_at,
    lastRunAt: r.last_run_at,
    lastRunStatus: normaliseLastStatus(r.last_run_status),
    lastRunError: r.last_run_error,
    lastSessionId: r.last_session_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToItem(r: ItemRow): NewsItem {
  return {
    id: r.id,
    topicId: r.topic_id,
    project: r.project,
    title: r.title,
    summary: r.summary,
    url: r.url,
    imageUrl: r.image_url,
    source: r.source,
    publishedAt: r.published_at,
    contentHash: r.content_hash,
    seenCount: r.seen_count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  };
}

// ── Topics ──────────────────────────────────────────────────────────────────

export interface CreateTopicOpts {
  project: string;
  name: string;
  description?: string;
  agent: string;
  terms?: string[];
  updateCron: string;
  renewTermsCron?: string | null;
  alwaysRegenerateTerms?: boolean;
  maxItemsPerRun?: number;
  enabled?: boolean;
  nextUpdateAt: number;
  nextRenewTermsAt?: number | null;
  createdBy: string;
}

function validateTerms(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("terms must be an array of strings");
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string")
      throw new Error("terms must contain only strings");
    const trimmed = t.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

export function createTopic(db: Database, opts: CreateTopicOpts): NewsTopic {
  const name = opts.name.trim();
  if (!name) throw new Error("topic name is required");
  const agent = opts.agent.trim();
  if (!agent) throw new Error("topic agent is required");
  const updateCron = opts.updateCron.trim();
  if (!updateCron) throw new Error("update_cron is required");
  const terms = validateTerms(opts.terms);
  const max = opts.maxItemsPerRun ?? 10;
  if (max < 1 || max > 100) {
    throw new Error("max_items_per_run must be between 1 and 100");
  }
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO web_news_topics(
         project, name, description, agent, terms,
         update_cron, renew_terms_cron, always_regenerate_terms,
         max_items_per_run, enabled, run_status,
         next_update_at, next_renew_terms_at,
         last_run_at, last_run_status, last_run_error, last_session_id,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      opts.project,
      name,
      opts.description ?? "",
      agent,
      JSON.stringify(terms),
      updateCron,
      opts.renewTermsCron ?? null,
      opts.alwaysRegenerateTerms ? 1 : 0,
      max,
      opts.enabled === false ? 0 : 1,
      opts.nextUpdateAt,
      opts.nextRenewTermsAt ?? null,
      opts.createdBy,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  return getTopic(db, id)!;
}

export function getTopic(db: Database, id: number): NewsTopic | null {
  const row = db
    .prepare(`SELECT ${TOPIC_COLS} FROM web_news_topics WHERE id = ?`)
    .get(id) as TopicRow | undefined;
  return row ? rowToTopic(row) : null;
}

export function listTopics(db: Database, project: string): NewsTopic[] {
  const rows = db
    .prepare(
      `SELECT ${TOPIC_COLS} FROM web_news_topics WHERE project = ? ORDER BY name ASC`,
    )
    .all(project) as TopicRow[];
  return rows.map(rowToTopic);
}

export interface UpdateTopicPatch {
  name?: string;
  description?: string;
  agent?: string;
  terms?: string[];
  updateCron?: string;
  renewTermsCron?: string | null;
  alwaysRegenerateTerms?: boolean;
  maxItemsPerRun?: number;
  enabled?: boolean;
  nextUpdateAt?: number;
  nextRenewTermsAt?: number | null;
  lastSessionId?: string | null;
}

export function updateTopic(
  db: Database,
  id: number,
  patch: UpdateTopicPatch,
): NewsTopic {
  const existing = getTopic(db, id);
  if (!existing) throw new Error(`topic ${id} not found`);

  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name) throw new Error("topic name is required");
  const description =
    patch.description === undefined ? existing.description : patch.description;
  const agent = patch.agent === undefined ? existing.agent : patch.agent.trim();
  if (!agent) throw new Error("topic agent is required");
  const terms =
    patch.terms === undefined ? existing.terms : validateTerms(patch.terms);
  const updateCron =
    patch.updateCron === undefined
      ? existing.updateCron
      : patch.updateCron.trim();
  if (!updateCron) throw new Error("update_cron is required");
  const renewTermsCron =
    patch.renewTermsCron === undefined
      ? existing.renewTermsCron
      : patch.renewTermsCron && patch.renewTermsCron.trim()
        ? patch.renewTermsCron.trim()
        : null;
  const alwaysRegenerateTerms =
    patch.alwaysRegenerateTerms === undefined
      ? existing.alwaysRegenerateTerms
      : patch.alwaysRegenerateTerms;
  const maxItemsPerRun =
    patch.maxItemsPerRun === undefined
      ? existing.maxItemsPerRun
      : patch.maxItemsPerRun;
  if (maxItemsPerRun < 1 || maxItemsPerRun > 100) {
    throw new Error("max_items_per_run must be between 1 and 100");
  }
  const enabled =
    patch.enabled === undefined ? existing.enabled : patch.enabled;
  const nextUpdateAt =
    patch.nextUpdateAt === undefined
      ? existing.nextUpdateAt
      : patch.nextUpdateAt;
  const nextRenewTermsAt =
    patch.nextRenewTermsAt === undefined
      ? existing.nextRenewTermsAt
      : patch.nextRenewTermsAt;
  const lastSessionId =
    patch.lastSessionId === undefined
      ? existing.lastSessionId
      : patch.lastSessionId;

  db.prepare(
    `UPDATE web_news_topics
       SET name = ?, description = ?, agent = ?, terms = ?,
           update_cron = ?, renew_terms_cron = ?, always_regenerate_terms = ?,
           max_items_per_run = ?, enabled = ?,
           next_update_at = ?, next_renew_terms_at = ?, last_session_id = ?,
           updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    description,
    agent,
    JSON.stringify(terms),
    updateCron,
    renewTermsCron,
    alwaysRegenerateTerms ? 1 : 0,
    maxItemsPerRun,
    enabled ? 1 : 0,
    nextUpdateAt,
    nextRenewTermsAt,
    lastSessionId,
    Date.now(),
    id,
  );
  return getTopic(db, id)!;
}

export function deleteTopic(db: Database, id: number): void {
  db.prepare(`DELETE FROM web_news_topics WHERE id = ?`).run(id);
}

/**
 * Conditionally flip `run_status` to `'running'`. Returns true when this caller
 * won the race. Losers get a 409.
 */
export function claimTopicForRun(db: Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE web_news_topics
         SET run_status = 'running', last_run_error = NULL, updated_at = ?
       WHERE id = ? AND run_status != 'running'`,
    )
    .run(Date.now(), id);
  return info.changes > 0;
}

export interface ReleaseTopicOpts {
  status: LastRunStatus;
  error?: string | null;
  nextUpdateAt?: number;
  nextRenewTermsAt?: number | null;
  terms?: string[];
  sessionId?: string;
}

export function releaseTopic(
  db: Database,
  id: number,
  opts: ReleaseTopicOpts,
): NewsTopic {
  const existing = getTopic(db, id);
  if (!existing) throw new Error(`topic ${id} not found`);
  const now = Date.now();
  const terms = opts.terms ? JSON.stringify(validateTerms(opts.terms)) : null;
  db.prepare(
    `UPDATE web_news_topics
       SET run_status = 'idle',
           last_run_at = ?, last_run_status = ?, last_run_error = ?,
           next_update_at = COALESCE(?, next_update_at),
           next_renew_terms_at = CASE
             WHEN ? = 1 THEN ?
             ELSE next_renew_terms_at
           END,
           terms = COALESCE(?, terms),
           last_session_id = COALESCE(?, last_session_id),
           updated_at = ?
     WHERE id = ?`,
  ).run(
    now,
    opts.status,
    opts.error ?? null,
    opts.nextUpdateAt ?? null,
    opts.nextRenewTermsAt !== undefined ? 1 : 0,
    opts.nextRenewTermsAt ?? null,
    terms,
    opts.sessionId ?? null,
    now,
    id,
  );
  return getTopic(db, id)!;
}

/** Select due topics: update_at has passed OR renew_at has passed. Only idle + enabled rows. */
export interface DueTopic {
  id: number;
  project: string;
  renewDue: boolean;
  updateDue: boolean;
}

export function selectDueTopics(db: Database, now: number): DueTopic[] {
  const rows = db
    .prepare(
      `SELECT id, project, next_update_at, next_renew_terms_at
         FROM web_news_topics
        WHERE enabled = 1
          AND run_status = 'idle'
          AND ( next_update_at <= ? OR
                (next_renew_terms_at IS NOT NULL AND next_renew_terms_at <= ?) )
        ORDER BY next_update_at ASC`,
    )
    .all(now, now) as Array<{
    id: number;
    project: string;
    next_update_at: number;
    next_renew_terms_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    updateDue: r.next_update_at <= now,
    renewDue: r.next_renew_terms_at !== null && r.next_renew_terms_at <= now,
  }));
}

// ── Items ───────────────────────────────────────────────────────────────────

export function normaliseUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    // Drop common tracking params so reshares on the same URL dedupe.
    const TRACK = /^utm_|^fbclid$|^gclid$|^mc_/i;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACK.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function normaliseTitle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "");
}

export function computeContentHash(url: string, title: string): string {
  const key = `${normaliseUrl(url)}|${normaliseTitle(title)}`;
  return createHash("sha256").update(key).digest("hex");
}

export interface UpsertItemOpts {
  topicId: number;
  project: string;
  title: string;
  summary?: string;
  url?: string | null;
  imageUrl?: string | null;
  source?: string | null;
  publishedAt?: number | null;
  now?: number;
}

/** Insert a new item, or bump `seen_count` + `last_seen_at` when it already exists. */
export function upsertNewsItem(
  db: Database,
  opts: UpsertItemOpts,
): { item: NewsItem; inserted: boolean } {
  const title = opts.title.trim();
  if (!title) throw new Error("item title is required");
  const hash = computeContentHash(opts.url ?? "", title);
  const now = opts.now ?? Date.now();

  const existing = db
    .prepare(
      `SELECT ${ITEM_COLS} FROM web_news_items
        WHERE topic_id = ? AND content_hash = ?`,
    )
    .get(opts.topicId, hash) as ItemRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE web_news_items
         SET seen_count = seen_count + 1, last_seen_at = ?
       WHERE id = ?`,
    ).run(now, existing.id);
    const refreshed = db
      .prepare(`SELECT ${ITEM_COLS} FROM web_news_items WHERE id = ?`)
      .get(existing.id) as ItemRow;
    return { item: rowToItem(refreshed), inserted: false };
  }

  const info = db
    .prepare(
      `INSERT INTO web_news_items(
         topic_id, project, title, summary, url, image_url, source,
         published_at, content_hash, seen_count,
         first_seen_at, last_seen_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      opts.topicId,
      opts.project,
      title,
      opts.summary ?? "",
      opts.url ?? null,
      opts.imageUrl ?? null,
      opts.source ?? null,
      opts.publishedAt ?? null,
      hash,
      now,
      now,
      now,
    );
  const row = db
    .prepare(`SELECT ${ITEM_COLS} FROM web_news_items WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ItemRow;
  return { item: rowToItem(row), inserted: true };
}

export interface ListItemsOpts {
  topicId?: number;
  limit?: number;
  since?: number;
}

export function listItemsForProject(
  db: Database,
  project: string,
  opts: ListItemsOpts = {},
): NewsItem[] {
  const conditions = ["project = ?"];
  const params: (string | number)[] = [project];
  if (opts.topicId !== undefined) {
    conditions.push("topic_id = ?");
    params.push(opts.topicId);
  }
  if (opts.since !== undefined) {
    conditions.push("first_seen_at >= ?");
    params.push(opts.since);
  }
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const rows = db
    .prepare(
      `SELECT ${ITEM_COLS} FROM web_news_items
        WHERE ${conditions.join(" AND ")}
        ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as ItemRow[];
  return rows.map(rowToItem);
}

/** Returns the last N items for a topic — feeds the LLM dedup list. */
export function listRecentItemsForTopic(
  db: Database,
  topicId: number,
  limit = 30,
): NewsItem[] {
  const rows = db
    .prepare(
      `SELECT ${ITEM_COLS} FROM web_news_items
        WHERE topic_id = ?
        ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(topicId, limit) as ItemRow[];
  return rows.map(rowToItem);
}

export function getNewsItem(db: Database, id: number): NewsItem | null {
  const row = db
    .prepare(`SELECT ${ITEM_COLS} FROM web_news_items WHERE id = ?`)
    .get(id) as ItemRow | undefined;
  return row ? rowToItem(row) : null;
}

export function deleteNewsItem(db: Database, id: number): void {
  db.prepare(`DELETE FROM web_news_items WHERE id = ?`).run(id);
}

// ── Permissions ──────────────────────────────────────────────────────────────

export function canEditTopic(
  user: User,
  topic: NewsTopic,
  project: Project,
): boolean {
  if (user.role === "admin") return true;
  if (project.createdBy && project.createdBy === user.id) return true;
  if (topic.createdBy === user.id) return true;
  return false;
}
