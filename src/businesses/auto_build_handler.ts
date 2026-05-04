/**
 * Scheduler handler: auto-build businesses from contact signals (ADR 0036).
 *
 * Per project where the per-project `auto_build_businesses` flag (or the
 * cfg.businesses.autoBuildEnabled fallback) is true:
 *   1. Walk every alive contact in the project.
 *   2. Extract candidate (name, domain) pairs from `company`, email domains,
 *      and any `socials` entry with `platform = 'website'` (or known social
 *      platforms — for future expansion).
 *   3. Deduplicate; for each unseen pair, call `upsertBusinessByName` which
 *      uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id` (race-safe under
 *      the partial UNIQUE indexes on `(project, lower(name))` and
 *      `(project, domain)`). The returned id flows into a fresh
 *      `contact_businesses` link.
 *   4. Newly-created rows get `soul_next_refresh_at = now` so the soul-refresh
 *      handler picks them up on its next tick.
 *   5. Optional one-shot enrichment: for up to `cfg.businesses.autoBuildBatchSize`
 *      newly created businesses per tick, run a brief `web_search`-driven
 *      runAgent to populate description/website/socials.
 *
 * Cap on LLM calls per tick: `cfg.businesses.autoBuildBatchSize`. Cap on
 * insert work per tick is unbounded but cheap (only writes for unseen pairs).
 */

import { randomUUID } from "node:crypto";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { getSystemUserId } from "../auth/seed.ts";
import { listProjects } from "../memory/projects.ts";
import { resolvePrompt, interpolate } from "../prompts/resolve.ts";
import { registry as toolRegistry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import {
  listContacts,
  linkContactBusiness,
  validateSocials,
  type SocialHandle,
} from "../memory/contacts.ts";
import {
  updateBusiness,
  upsertBusinessByName,
  validateAddress,
  type BusinessAddress,
} from "../memory/businesses.ts";
import { extractFencedJson } from "../memory/entity_soul_constants.ts";

export const BUSINESS_AUTO_BUILD_HANDLER = "business.auto_build";

/** Lowercase-trim host part of an email address. Returns null when malformed. */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const host = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return host && host.includes(".") ? host : null;
}

/** Strip protocol + www + trailing slash + path from a URL host. */
function urlDomain(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    const host = u.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

interface Candidate {
  /** Display name (preserves casing of the strongest signal). */
  name: string;
  /** Lowercased domain or null. */
  domain: string | null;
  /** Source contact ids — every newly-created business gets linked back. */
  contactIds: number[];
}

/**
 * Extract per-project candidates from the alive contact set. Dedup key is
 * `lower(name)` first, then `domain` — so "Acme Inc." and "Acme" coalesce on
 * the same key when they share a domain. Order of contact-ids is stable.
 */
export function collectCandidates(
  contacts: ReadonlyArray<{
    id: number;
    company: string;
    emails: string[];
    socials: SocialHandle[];
  }>,
): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const upsert = (name: string, domain: string | null, contactId: number) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = `${trimmed.toLowerCase()}|${domain ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.contactIds.includes(contactId)) {
        existing.contactIds.push(contactId);
      }
      return;
    }
    byKey.set(key, { name: trimmed, domain, contactIds: [contactId] });
  };

  // Two-pass strategy: first pass companies (strongest signal — operator-typed
  // organisation name); second pass website + email domains where the name is
  // missing. We don't conjure names from a domain; only attach domains to
  // already-known names where one is unknown.
  const domainsForContact = new Map<number, Set<string>>();
  for (const c of contacts) {
    const domains = new Set<string>();
    for (const e of c.emails) {
      const d = emailDomain(e);
      if (d) domains.add(d);
    }
    for (const s of c.socials) {
      const candidate = s.url ?? s.handle;
      if (!candidate) continue;
      const d = urlDomain(candidate);
      if (d) domains.add(d);
    }
    domainsForContact.set(c.id, domains);
  }

  for (const c of contacts) {
    const company = c.company?.trim();
    if (!company) continue;
    const domains = domainsForContact.get(c.id)!;
    if (domains.size === 0) {
      upsert(company, null, c.id);
    } else {
      for (const d of domains) upsert(company, d, c.id);
    }
  }

  return [...byKey.values()];
}

/**
 * Resolve whether the auto-build handler is enabled for a project. Per-project
 * column wins; falls back to cfg.businesses.autoBuildEnabled when the column
 * is at its default 0.
 */
function autoBuildEnabledFor(perProject: boolean, fallback: boolean): boolean {
  // The column defaults to 0; treat 0 as "use fallback" so a process-wide
  // toggle works without editing every project.
  return perProject || fallback;
}

interface EnrichResult {
  description: string;
  website?: string | undefined;
  emails: string[];
  phones: string[];
  socials: SocialHandle[];
  address: BusinessAddress | null;
}

function parseEnrichJson(raw: string): EnrichResult | null {
  const obj = extractFencedJson(raw);
  if (!obj) return null;
  const rawDescription = obj["description"];
  const description =
    typeof rawDescription === "string" ? rawDescription.trim() : "";
  const rawWebsite = obj["website"];
  const website =
    typeof rawWebsite === "string" && rawWebsite.trim()
      ? rawWebsite.trim()
      : undefined;
  const rawEmails = obj["emails"];
  const emails = Array.isArray(rawEmails)
    ? rawEmails.filter((e: unknown): e is string => typeof e === "string")
    : [];
  const rawPhones = obj["phones"];
  const phones = Array.isArray(rawPhones)
    ? rawPhones.filter((p: unknown): p is string => typeof p === "string")
    : [];
  const rawSocials = obj["socials"];
  const socials = Array.isArray(rawSocials) ? validateSocials(rawSocials) : [];
  const address = validateAddress(obj["address"]);
  if (
    !description &&
    !website &&
    emails.length === 0 &&
    phones.length === 0 &&
    socials.length === 0 &&
    !address
  ) {
    return null;
  }
  return { description, website, emails, phones, socials, address };
}

export interface RunAutoBuildOpts {
  db: import("bun:sqlite").Database;
  queue: import("../queue/bunqueue.ts").BunnyQueue;
  cfg: import("../config.ts").BunnyConfig;
  /**
   * Constrain the run to one project. Used by the per-project HTTP route so
   * an admin clicking "Auto-build" in project A doesn't also trigger builds
   * for unrelated opt-in projects B and C.
   */
  onlyProject?: string;
}

/**
 * Shared core: extract candidates → race-safe insert → optional enrichment.
 * The periodic handler walks every opt-in project; the HTTP route passes
 * `onlyProject` to scope the run to the requesting project.
 */
export async function runBusinessAutoBuild(
  opts: RunAutoBuildOpts,
): Promise<void> {
  const { db, queue, cfg } = opts;
  const allProjects = listProjects(db);
  const projects = opts.onlyProject
    ? allProjects.filter((p) => p.name === opts.onlyProject)
    : allProjects;
  const systemUserId = getSystemUserId(db);
  let llmBudget = cfg.businesses.autoBuildBatchSize;

  for (const project of projects) {
    if (
      !autoBuildEnabledFor(
        project.autoBuildBusinesses,
        cfg.businesses.autoBuildEnabled,
      )
    ) {
      continue;
    }
    const { contacts } = listContacts(db, project.name);
    if (contacts.length === 0) continue;
    const candidates = collectCandidates(
      contacts.map((c) => ({
        id: c.id,
        company: c.company,
        emails: c.emails,
        socials: c.socials,
      })),
    );
    if (candidates.length === 0) continue;

    for (const cand of candidates) {
      const { id: businessId, created } = upsertBusinessByName(db, {
        project: project.name,
        name: cand.name,
        domain: cand.domain,
        source: "auto_from_contacts",
        createdBy: systemUserId,
        originalLang: project.defaultLanguage,
      });
      // Always link — link is idempotent via PK. Cheap when already linked.
      for (const cId of cand.contactIds) {
        linkContactBusiness(db, cId, businessId);
      }
      if (!created) continue;

      void queue.log({
        topic: "business",
        kind: "auto_build.created",
        userId: systemUserId,
        data: {
          id: businessId,
          project: project.name,
          name: cand.name,
          domain: cand.domain,
          linkedContacts: cand.contactIds.length,
        },
      });

      // Optional single enrichment call — capped per tick across all projects.
      if (llmBudget <= 0) continue;
      llmBudget -= 1;
      try {
        const sessionId = `business-build-${randomUUID()}`;
        setSessionHiddenFromChat(db, systemUserId, sessionId, true);
        const userPrompt = interpolate(
          resolvePrompt("business.auto_build.enrich", {
            project: project.name,
          }),
          {
            name: cand.name,
            domain: cand.domain ?? "(unknown)",
            searchResults: "(none yet — perform fresh searches)",
          },
        );
        const answer = await runAgent({
          prompt: `Enrich the new business ${cand.name}.`,
          sessionId,
          userId: systemUserId,
          project: project.name,
          llmCfg: cfg.llm,
          embedCfg: cfg.embed,
          memoryCfg: cfg.memory,
          agentCfg: cfg.agent,
          webCfg: cfg.web,
          tools: toolRegistry,
          db,
          queue,
          renderer: silentRenderer(),
          systemPromptOverride: userPrompt,
          originAutomation: true,
        });
        const parsed = parseEnrichJson(answer);
        if (parsed) {
          updateBusiness(db, businessId, {
            description: parsed.description,
            ...(parsed.website !== undefined
              ? { website: parsed.website }
              : {}),
            emails: parsed.emails,
            phones: parsed.phones,
            socials: parsed.socials,
            ...(parsed.address ? { address: parsed.address } : {}),
          });
          void queue.log({
            topic: "business",
            kind: "auto_build.enriched",
            userId: systemUserId,
            data: {
              id: businessId,
              project: project.name,
              addressFilled: parsed.address !== null,
            },
          });
        }
      } catch (e) {
        const msg = errorMessage(e);
        void queue.log({
          topic: "business",
          kind: "auto_build.enrich_error",
          userId: systemUserId,
          data: { id: businessId, project: project.name },
          error: msg,
        });
      }
    }
  }
}

/** Scheduler entry — walks every opt-in project. */
export async function businessAutoBuildHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  await runBusinessAutoBuild({ db: ctx.db, queue: ctx.queue, cfg: ctx.cfg });
}

export function registerBusinessAutoBuild(registry: HandlerRegistry): void {
  registry.register(BUSINESS_AUTO_BUILD_HANDLER, businessAutoBuildHandler);
}
