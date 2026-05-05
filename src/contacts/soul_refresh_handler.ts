/**
 * Scheduler handler: periodically refresh the per-contact soul body via an
 * LLM with web tools (web_search + web_fetch).
 *
 * Mirrors `src/kb/auto_generate_handler.ts` in shape — race-safe per-row
 * claim (`claimContactSoulRefresh`), hidden LLM session, runAgent with
 * `webCfg` spliced in, JSON output parsed via `extractSoulJson`,
 * `try/catch/finally` so the row never stays `'refreshing'`.
 *
 * Cadence is configured via `cfg.contacts.soulRefreshCron` (default every
 * 6 hours). Each tick processes up to `cfg.contacts.soulRefreshBatchSize` rows.
 *
 * Translation stale-marking is gated by `cfg.contacts.translateSoul` — when
 * false the handler advances `soul`+`soul_sources` without touching
 * `contact_translations`.
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer, type Renderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { getProject } from "../memory/projects.ts";
import { getSystemUserId } from "../auth/seed.ts";
import { resolvePrompt, interpolate } from "../prompts/resolve.ts";
import { registry as toolRegistry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import {
  ENTITY_SOUL_CHAR_LIMIT,
  extractSoulJson,
} from "../memory/entity_soul_constants.ts";
import {
  claimContactSoulRefresh,
  listContactSoulRefreshCandidates,
  releaseStuckContactSouls,
  setContactSoulAuto,
  setContactSoulError,
  type Contact,
  type SoulSource,
} from "../memory/contacts.ts";

export const CONTACT_SOUL_REFRESH_HANDLER = "contact.soul_refresh";

function renderSocials(c: Contact): string {
  if (c.socials.length === 0) return "(none)";
  return c.socials
    .map((s) => `- ${s.platform}: ${s.url ?? s.handle}`)
    .join("\n");
}

function pickWebsite(c: Contact): string {
  const website = c.socials.find((s) => s.platform === "website");
  return website?.url ?? website?.handle ?? "(none)";
}

export interface RefreshOneOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  contact: Contact;
  /**
   * Optional renderer — defaults to `silentRenderer()`. The HTTP "Refresh now"
   * route passes an SSE renderer so the user sees live progress.
   */
  renderer?: Renderer;
  /**
   * True when invoked from the periodic scheduler. Stamps `from_automation = 1`
   * on every message row written by the inner runAgent so memory.refresh
   * ignores them. The HTTP "Refresh now" route leaves this off (default).
   */
  automation?: boolean;
}

export type RefreshOneOutcome = "ok" | "lost_race" | "parse_error" | "error";

/**
 * Per-row soul refresh, used by both the periodic handler and the on-demand
 * route. Caller must guarantee the row is alive. Returns the outcome so the
 * caller can decide what to log / surface; this function never throws.
 */
export async function refreshOneContactSoul(
  opts: RefreshOneOpts,
): Promise<RefreshOneOutcome> {
  const { db, queue, cfg, contact } = opts;
  if (!claimContactSoulRefresh(db, contact.id)) return "lost_race";

  const systemUserId = getSystemUserId(db);
  const cadenceMs = cfg.contacts.soulRefreshCadenceH * 60 * 60 * 1000;
  const userId = contact.createdBy ?? systemUserId;
  const project = getProject(db, contact.project);
  const targetLang = contact.originalLang ?? project?.defaultLanguage ?? "en";
  const sessionId = `contact-soul-${crypto.randomUUID()}`;
  setSessionHiddenFromChat(db, userId, sessionId, true);

  const systemPrompt = resolvePrompt("contact.soul.refresh", {
    project: contact.project,
  });
  const filled = interpolate(systemPrompt, {
    project: contact.project,
    contactName: contact.name,
    currentSoul: contact.soul || "(empty)",
    socials: renderSocials(contact),
    website: pickWebsite(contact),
    targetLang,
    budget: String(ENTITY_SOUL_CHAR_LIMIT),
  });

  void queue.log({
    topic: "contact",
    kind: "soul.refresh.start",
    userId,
    data: { id: contact.id, project: contact.project },
  });

  try {
    const answer = await runAgent({
      prompt: `Refresh the soul for ${contact.name}.`,
      sessionId,
      userId,
      project: contact.project,
      llmCfg: cfg.llm,
      embedCfg: cfg.embed,
      memoryCfg: cfg.memory,
      agentCfg: cfg.agent,
      webCfg: cfg.web,
      tools: toolRegistry,
      db,
      queue,
      renderer: opts.renderer ?? silentRenderer(),
      systemPromptOverride: filled,
      originAutomation: opts.automation,
    });

    const parsed = extractSoulJson(answer);
    if (!parsed) {
      setContactSoulError(db, contact.id, "parse_failed", cadenceMs);
      void queue.log({
        topic: "contact",
        kind: "soul.refresh.parse_error",
        userId,
        data: { id: contact.id, project: contact.project },
      });
      return "parse_error";
    }

    const sources: SoulSource[] = parsed.sources.map((url) => ({
      url,
      fetchedAt: Date.now(),
    }));
    setContactSoulAuto(db, contact.id, parsed.soul, sources, cadenceMs, {
      markStale: cfg.contacts.translateSoul,
    });
    void queue.log({
      topic: "contact",
      kind: "soul.refresh.done",
      userId,
      data: {
        id: contact.id,
        project: contact.project,
        soulChars: parsed.soul.length,
        sources: parsed.sources.length,
      },
    });
    return "ok";
  } catch (e) {
    const msg = errorMessage(e);
    try {
      setContactSoulError(db, contact.id, msg, cadenceMs);
    } catch {
      // swallow — DB may be closed during teardown
    }
    void queue.log({
      topic: "contact",
      kind: "soul.refresh.error",
      userId,
      data: { id: contact.id, project: contact.project },
      error: msg,
    });
    return "error";
  }
}

export async function contactSoulRefreshHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg } = ctx;
  releaseStuckContactSouls(db, cfg.contacts.soulStuckThresholdMs);

  const candidates = listContactSoulRefreshCandidates(db, {
    limit: cfg.contacts.soulRefreshBatchSize,
  });
  if (candidates.length === 0) return;
  for (const cand of candidates) {
    await refreshOneContactSoul({
      db,
      queue,
      cfg,
      contact: cand,
      automation: true,
    });
  }
}

export function registerContactSoulRefresh(registry: HandlerRegistry): void {
  registry.register(CONTACT_SOUL_REFRESH_HANDLER, contactSoulRefreshHandler);
}
