/**
 * Translation routes.
 *
 * Single-entry point for listing and manually triggering per-entity
 * translations. Kind-agnostic — dispatches to the translatable registry.
 * Background translation runs via the `translation.auto_translate_scan`
 * scheduler task; this route is the "Translate now" shortcut surfaced in the
 * UI and the API for ad-hoc triggers.
 *
 * Endpoints:
 *   GET  /api/projects/:project/translations/:kind/:id
 *   POST /api/projects/:project/translations/:kind/:id/:lang
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import type { SchedulerHandle } from "../scheduler/ticker.ts";
import { json } from "./http.ts";
import { getProject } from "../memory/projects.ts";
import { canSeeProject } from "./routes.ts";
import {
  ensureLanguageRows,
  getKind,
  getSourceVersion,
  listTranslations,
  TRANSLATABLE_REGISTRY,
  type TranslatableKind,
  type TranslationRow,
} from "../memory/translatable.ts";
import { getDefinition, canEditDefinition } from "../memory/kb_definitions.ts";
import { getDocument, canEditDocument } from "../memory/documents.ts";
import { getContact, canEditContact } from "../memory/contacts.ts";
import { getCard, canEditCard } from "../memory/board_cards.ts";

export interface TranslationRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  scheduler: SchedulerHandle;
}

/** Entity row plus project membership + edit permission, keyed by kind. */
interface EntityCheck {
  project: string;
  originalLang: string | null;
  canEdit: (user: User, project: ReturnType<typeof getProject>) => boolean;
}

function fetchEntity(
  db: Database,
  kind: TranslatableKind,
  id: number,
  user: User,
): { entity: EntityCheck; canSee: boolean; canEdit: boolean } | null {
  if (kind.name === "kb_definition") {
    const def = getDefinition(db, id);
    if (!def) return null;
    const pr = getProject(db, def.project);
    if (!pr) return null;
    return {
      entity: {
        project: def.project,
        originalLang: null,
        canEdit: () => false,
      },
      canSee: canSeeProject(pr, user),
      canEdit: canEditDefinition(user, def, pr),
    };
  }
  if (kind.name === "document") {
    const doc = getDocument(db, id);
    if (!doc) return null;
    const pr = getProject(db, doc.project);
    if (!pr) return null;
    return {
      entity: {
        project: doc.project,
        originalLang: null,
        canEdit: () => false,
      },
      canSee: canSeeProject(pr, user),
      canEdit: canEditDocument(user, doc, pr),
    };
  }
  if (kind.name === "contact") {
    const c = getContact(db, id);
    if (!c) return null;
    const pr = getProject(db, c.project);
    if (!pr) return null;
    return {
      entity: { project: c.project, originalLang: null, canEdit: () => false },
      canSee: canSeeProject(pr, user),
      canEdit: canEditContact(user, c, pr),
    };
  }
  if (kind.name === "board_card") {
    const card = getCard(db, id);
    if (!card) return null;
    const pr = getProject(db, card.project);
    if (!pr) return null;
    return {
      entity: {
        project: card.project,
        originalLang: null,
        canEdit: () => false,
      },
      canSee: canSeeProject(pr, user),
      canEdit: canEditCard(user, card, pr),
    };
  }
  return null;
}

function toDto(
  t: TranslationRow,
  projectLanguages: readonly string[],
): Record<string, unknown> {
  return {
    id: t.id,
    lang: t.lang,
    status: t.status,
    error: t.error,
    sourceVersion: t.sourceVersion,
    sourceHash: t.sourceHash,
    translatingAt: t.translatingAt,
    isOrphaned: !projectLanguages.includes(t.lang),
    fields: t.fields,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function parsePath(pathname: string): {
  project: string;
  kindName: string;
  id: number;
  lang?: string;
} | null {
  const m = pathname.match(
    /^\/api\/projects\/([^/]+)\/translations\/([^/]+)\/(\d+)(?:\/([a-z]{2}))?\/?$/,
  );
  if (!m) return null;
  return {
    project: decodeURIComponent(m[1]!),
    kindName: m[2]!,
    id: Number(m[3]!),
    lang: m[4],
  };
}

export async function handleTranslationRoute(
  req: Request,
  url: URL,
  ctx: TranslationRouteCtx,
  user: User,
): Promise<Response | null> {
  const parsed = parsePath(url.pathname);
  if (!parsed) return null;
  const kind = getKind(parsed.kindName);
  if (!kind) return json({ error: `unknown kind '${parsed.kindName}'` }, 404);
  const pr = getProject(ctx.db, parsed.project);
  if (!pr) return json({ error: "project not found" }, 404);

  const check = fetchEntity(ctx.db, kind, parsed.id, user);
  if (!check) return json({ error: "entity not found" }, 404);
  if (check.entity.project !== parsed.project) {
    return json({ error: "entity not in this project" }, 400);
  }
  if (!check.canSee) return json({ error: "forbidden" }, 403);

  // GET /api/projects/:p/translations/:kind/:id
  if (!parsed.lang && req.method === "GET") {
    const rows = listTranslations(ctx.db, kind, parsed.id);
    return json({
      kind: kind.name,
      entityId: parsed.id,
      projectLanguages: pr.languages,
      defaultLanguage: pr.defaultLanguage,
      translations: rows.map((r) => toDto(r, pr.languages)),
    });
  }

  // POST /api/projects/:p/translations/:kind/:id/:lang  (trigger one)
  if (parsed.lang && req.method === "POST") {
    if (!check.canEdit) return json({ error: "forbidden" }, 403);
    const lang = parsed.lang.toLowerCase();
    if (!pr.languages.includes(lang)) {
      return json(
        {
          error: `language '${lang}' is not configured on this project`,
        },
        400,
      );
    }
    const sourceVersion = getSourceVersion(ctx.db, kind, parsed.id);
    if (sourceVersion === null) {
      return json({ error: "entity not found" }, 404);
    }
    const entitySourceRow = ctx.db
      .prepare(`SELECT original_lang FROM ${kind.entityTable} WHERE id = ?`)
      .get(parsed.id) as { original_lang: string | null } | undefined;
    const originalLang = entitySourceRow?.original_lang ?? pr.defaultLanguage;
    if (lang === originalLang) {
      return json(
        {
          error: `lang '${lang}' is the source language of this entity`,
        },
        400,
      );
    }
    // Upsert the sidecar row as pending (ensureLanguageRows is a no-op if it
    // already exists). Then flip status to pending unconditionally so a stale
    // 'ready' or 'error' row gets re-enqueued.
    ensureLanguageRows(
      ctx.db,
      kind,
      parsed.id,
      originalLang,
      [lang],
      sourceVersion,
    );
    ctx.db
      .prepare(
        `UPDATE ${kind.sidecarTable}
            SET status = 'pending', error = NULL, translating_at = NULL, updated_at = ?
          WHERE ${kind.entityFk} = ? AND lang = ?`,
      )
      .run(Date.now(), parsed.id, lang);
    void ctx.queue.log({
      topic: "translation",
      kind: "manual.trigger",
      userId: user.id,
      data: {
        kind: kind.name,
        entityId: parsed.id,
        project: parsed.project,
        lang,
      },
    });
    // Fire the scheduler's translation task immediately so the user doesn't
    // wait up to 5 minutes for the tick. The task ID is looked up by handler
    // name; missing rows (e.g. during tests without a seeded scheduler) are
    // silently ignored.
    const taskRow = ctx.db
      .prepare(
        `SELECT id FROM scheduled_tasks WHERE handler = ? AND kind = 'system' LIMIT 1`,
      )
      .get("translation.auto_translate_scan") as { id: string } | undefined;
    if (taskRow) {
      void ctx.scheduler.runTask(taskRow.id, Date.now()).catch(() => undefined);
    }
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

export function listRegistryNames(): string[] {
  return Object.keys(TRANSLATABLE_REGISTRY);
}
