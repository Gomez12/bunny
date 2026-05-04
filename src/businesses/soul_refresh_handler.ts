/**
 * Scheduler handler: periodically refresh the per-business soul body.
 *
 * Mirror of `src/contacts/soul_refresh_handler.ts` — same race-safe claim,
 * hidden session, runAgent + webCfg, JSON output via `extractSoulJson`,
 * `try/catch/finally` guarantee.
 *
 * Source data is the business's website + socials. Cadence configured via
 * `cfg.businesses.soulRefreshCron`. Translation stale-marking gated by
 * `cfg.businesses.translateSoul`.
 */

import { randomUUID } from "node:crypto";
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
  claimBusinessSoulRefresh,
  listBusinessSoulRefreshCandidates,
  releaseStuckBusinessSouls,
  setBusinessAddressAuto,
  setBusinessSoulAuto,
  setBusinessSoulError,
  validateAddress,
  type Business,
} from "../memory/businesses.ts";
import type { SoulSource } from "../memory/contacts.ts";

export const BUSINESS_SOUL_REFRESH_HANDLER = "business.soul_refresh";

function renderSocials(b: Business): string {
  if (b.socials.length === 0) return "(none)";
  return b.socials
    .map((s) => `- ${s.platform}: ${s.url ?? s.handle}`)
    .join("\n");
}

export interface RefreshOneOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  business: Business;
  renderer?: Renderer;
}

export type RefreshOneOutcome = "ok" | "lost_race" | "parse_error" | "error";

export async function refreshOneBusinessSoul(
  opts: RefreshOneOpts,
): Promise<RefreshOneOutcome> {
  const { db, queue, cfg, business } = opts;
  if (!claimBusinessSoulRefresh(db, business.id)) return "lost_race";

  const systemUserId = getSystemUserId(db);
  const cadenceMs = cfg.businesses.soulRefreshCadenceH * 60 * 60 * 1000;
  const userId = business.createdBy ?? systemUserId;
  const project = getProject(db, business.project);
  const targetLang = business.originalLang ?? project?.defaultLanguage ?? "en";
  const sessionId = `business-soul-${randomUUID()}`;
  setSessionHiddenFromChat(db, userId, sessionId, true);

  const systemPrompt = resolvePrompt("business.soul.refresh", {
    project: business.project,
  });
  const filled = interpolate(systemPrompt, {
    project: business.project,
    businessName: business.name,
    domain: business.domain ?? "(unknown)",
    website: business.website ?? "(unknown)",
    socials: renderSocials(business),
    currentSoul: business.soul || "(empty)",
    targetLang,
    budget: String(ENTITY_SOUL_CHAR_LIMIT),
  });

  void queue.log({
    topic: "business",
    kind: "soul.refresh.start",
    userId,
    data: { id: business.id, project: business.project },
  });

  try {
    const answer = await runAgent({
      prompt: `Refresh the soul for ${business.name}.`,
      sessionId,
      userId,
      project: business.project,
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
    });

    const parsed = extractSoulJson(answer);
    if (!parsed) {
      setBusinessSoulError(db, business.id, "parse_failed", cadenceMs);
      void queue.log({
        topic: "business",
        kind: "soul.refresh.parse_error",
        userId,
        data: { id: business.id, project: business.project },
      });
      return "parse_error";
    }
    const sources: SoulSource[] = parsed.sources.map((url) => ({
      url,
      fetchedAt: Date.now(),
    }));
    setBusinessSoulAuto(db, business.id, parsed.soul, sources, cadenceMs, {
      markStale: cfg.businesses.translateSoul,
    });
    // Optional address extraction. validateAddress drops empty objects so a
    // missing or unverifiable address never blanks an existing one.
    const address = validateAddress(parsed.raw["address"]);
    if (address) {
      setBusinessAddressAuto(db, business.id, address);
    }
    void queue.log({
      topic: "business",
      kind: "soul.refresh.done",
      userId,
      data: {
        id: business.id,
        project: business.project,
        soulChars: parsed.soul.length,
        sources: parsed.sources.length,
        addressFilled: address !== null,
      },
    });
    return "ok";
  } catch (e) {
    const msg = errorMessage(e);
    try {
      setBusinessSoulError(db, business.id, msg, cadenceMs);
    } catch {
      /* swallow */
    }
    void queue.log({
      topic: "business",
      kind: "soul.refresh.error",
      userId,
      data: { id: business.id, project: business.project },
      error: msg,
    });
    return "error";
  }
}

export async function businessSoulRefreshHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg } = ctx;
  releaseStuckBusinessSouls(db, cfg.businesses.soulStuckThresholdMs);

  const candidates = listBusinessSoulRefreshCandidates(db, {
    limit: cfg.businesses.soulRefreshBatchSize,
  });
  if (candidates.length === 0) return;
  for (const cand of candidates) {
    await refreshOneBusinessSoul({ db, queue, cfg, business: cand });
  }
}

export function registerBusinessSoulRefresh(registry: HandlerRegistry): void {
  registry.register(BUSINESS_SOUL_REFRESH_HANDLER, businessSoulRefreshHandler);
}
