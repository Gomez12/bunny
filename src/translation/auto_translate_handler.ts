/**
 * Scheduler handler: translate pending sidecar rows across all registered kinds.
 *
 * Runs every 5 minutes. Per tick:
 *   1. For every registered kind, atomically claim up to `maxPerTick` rows
 *      with `status='pending'` (flips them to `translating`, stamps
 *      `translating_at`).
 *   2. For each claimed row: fetch the entity's source fields, recompute the
 *      sha256 hash, and if it matches the stored `source_hash` short-circuit
 *      to `ready` without calling the LLM. This absorbs edit→revert loops.
 *   3. Otherwise call `runAgent` with the translation system prompt, parse the
 *      fenced JSON, and write the translated fields.
 *   4. On throw/error, flip the row to `status='error'` so a retry comes from
 *      the user via POST /translations/:kind/:id/:lang or via re-editing the
 *      source.
 *
 * Stuck-row recovery is handled by `sweep_stuck_handler.ts`, not here — see
 * ADR 0022 for why that's a separate daily task rather than a per-tick scan.
 */

import { randomUUID } from "node:crypto";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import {
  claimPending,
  computeSourceHash,
  getEntitySource,
  listKinds,
  markReadyNoop,
  setError,
  setReady,
  type TranslatableKind,
  type TranslationRow,
} from "../memory/translatable.ts";
import { getProject } from "../memory/projects.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { registry as toolsRegistry } from "../tools/index.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { getSystemUserId } from "../auth/seed.ts";
import { errorMessage } from "../util/error.ts";

export const TRANSLATION_HANDLER = "translation.auto_translate_scan";

const DEFAULT_SYSTEM_PROMPT = `You are a professional translator. You will receive a JSON object listing one or more fields of a single entity, their current values in a source language, and the target language. Translate each field to the target language.

Rules:
- Preserve markdown structure, code blocks, inline HTML, escape sequences, and URLs verbatim. Never translate URL hosts, slugs, or anchor fragments.
- Do not add commentary, headings, or content that is not present in the source.
- Preserve proper names unless a well-known localisation exists.
- If the source value is an empty string or null, return an empty string.
- If a domain context is provided, prefer domain-aware terminology (e.g. in a project about cars, translate "chair" as "car seat" rather than "chair").

Output — return EXACTLY ONE fenced \`\`\`json\`\`\` block and nothing else, with one key per source field:

\`\`\`json
{
  "field_one": "translated value",
  "field_two": "translated value"
}
\`\`\`

Do not add any prose before or after the JSON block.`;

function buildUserPrompt(
  kind: TranslatableKind,
  sourceLang: string,
  targetLang: string,
  sourceFields: Record<string, string | null>,
  projectContext: string,
): string {
  const payload = {
    kind: kind.name,
    sourceLang,
    targetLang,
    projectContext,
    fields: Object.fromEntries(
      kind.sourceFields.map((f) => [f, sourceFields[f] ?? ""]),
    ),
  };
  return `Translate the following entity's fields from '${sourceLang}' to '${targetLang}'.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export function extractTranslationJson(
  raw: string,
  expectedKeys: readonly string[],
): Record<string, string> | null {
  const candidates: string[] = [];
  const fencedJson = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fencedJson?.[1]) candidates.push(fencedJson[1]);
  const fencedBare = raw.match(/```\s*\n([\s\S]*?)\n```/);
  if (fencedBare?.[1]) candidates.push(fencedBare[1]);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      if (!obj || typeof obj !== "object") continue;
      const out: Record<string, string> = {};
      let matched = false;
      for (const key of expectedKeys) {
        if (typeof obj[key] === "string") {
          out[key] = obj[key];
          matched = true;
        }
      }
      if (matched) return out;
    } catch {
      continue;
    }
  }
  return null;
}

async function translateOne(
  ctx: TaskHandlerContext,
  kind: TranslatableKind,
  row: TranslationRow,
): Promise<void> {
  const entity = getEntitySource(ctx.db, kind, row.entityId);
  if (!entity) {
    setError(ctx.db, kind, row.id, "entity vanished");
    return;
  }
  const sourceLang = entity.originalLang;
  if (!sourceLang) {
    setError(ctx.db, kind, row.id, "entity has no original_lang set");
    return;
  }
  const project = getProject(ctx.db, entity.project);
  if (!project) {
    setError(ctx.db, kind, row.id, `project '${entity.project}' vanished`);
    return;
  }
  if (!project.languages.includes(row.lang)) {
    // Language was removed from the project while this row was queued.
    // Treat as orphaned — surface as error so the UI can show it distinctly.
    setError(
      ctx.db,
      kind,
      row.id,
      `target language '${row.lang}' no longer configured on project`,
    );
    return;
  }

  // Hash-skip: if the source hasn't changed since the last successful
  // translation (edit → revert), just stamp the current source_version.
  const currentHash = computeSourceHash(entity.fields);
  if (row.sourceHash && row.sourceHash === currentHash) {
    markReadyNoop(ctx.db, kind, row.id, entity.sourceVersion);
    return;
  }

  // Oversize check — document content_md can balloon. Fail fast instead of
  // sending megabytes to the LLM.
  const maxBytes = ctx.cfg.translation.maxDocumentBytes;
  for (const f of kind.sourceFields) {
    const v = entity.fields[f] ?? "";
    if (Buffer.byteLength(v, "utf8") > maxBytes) {
      setError(
        ctx.db,
        kind,
        row.id,
        `field '${f}' exceeds ${maxBytes}-byte translation limit`,
      );
      return;
    }
  }

  const systemPrompt =
    ctx.cfg.translation.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const projectContext = (
    project.description?.trim() ? project.description.trim() : project.name
  ).trim();
  const userPrompt = buildUserPrompt(
    kind,
    sourceLang,
    row.lang,
    entity.fields,
    projectContext,
  );

  const sessionId = `translate-${kind.name}-${randomUUID()}`;
  const systemUserId = getSystemUserId(ctx.db);
  setSessionHiddenFromChat(ctx.db, systemUserId, sessionId, true);

  const renderer = silentRenderer();
  const answer = await runAgent({
    prompt: userPrompt,
    sessionId,
    userId: systemUserId,
    project: entity.project,
    llmCfg: ctx.cfg.llm,
    embedCfg: ctx.cfg.embed,
    memoryCfg: ctx.cfg.memory,
    agentCfg: ctx.cfg.agent,
    // Translation explicitly does not enable web tools — consistency with the
    // source beats extra information gathering.
    tools: toolsRegistry,
    db: ctx.db,
    queue: ctx.queue,
    renderer,
    systemPromptOverride: systemPrompt,
  });

  const parsed = extractTranslationJson(answer, kind.sourceFields);
  if (!parsed) {
    setError(ctx.db, kind, row.id, "model did not return a valid JSON block");
    void ctx.queue.log({
      topic: "translation",
      kind: "llm.parse_error",
      data: {
        kind: kind.name,
        entityId: row.entityId,
        lang: row.lang,
      },
    });
    return;
  }

  const fields: Record<string, string | null> = {};
  for (const c of kind.sidecarFields) {
    fields[c] = parsed[c] ?? "";
  }
  setReady(ctx.db, kind, row.id, fields, entity.sourceVersion, currentHash);
  void ctx.queue.log({
    topic: "translation",
    kind: "llm.done",
    data: {
      kind: kind.name,
      entityId: row.entityId,
      lang: row.lang,
      sourceVersion: entity.sourceVersion,
    },
  });
}

export async function autoTranslateHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const perTick = Math.max(1, ctx.cfg.translation.maxPerTick);
  for (const kind of listKinds()) {
    const claimed = claimPending(ctx.db, kind, perTick, ctx.now);
    for (const row of claimed) {
      try {
        await translateOne(ctx, kind, row);
      } catch (e) {
        const msg = errorMessage(e);
        try {
          setError(ctx.db, kind, row.id, msg);
        } catch {
          // swallow — DB may already be closed during test teardown
        }
        void ctx.queue.log({
          topic: "translation",
          kind: "handler.error",
          data: {
            kind: kind.name,
            entityId: row.entityId,
            lang: row.lang,
          },
          error: msg,
        });
      }
    }
  }
}

export function registerAutoTranslate(registry: HandlerRegistry): void {
  registry.register(TRANSLATION_HANDLER, autoTranslateHandler);
}
