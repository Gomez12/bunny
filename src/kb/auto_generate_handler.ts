/**
 * Scheduler handler: auto-generate LLM descriptions for KB definitions that
 * have never been generated (llm_short IS NULL, llm_cleared = 0).
 *
 * Mirrors src/web_news/auto_run_handler.ts in shape: the registry +
 * ensureSystemTask wiring lives in src/server/index.ts.
 */

import { randomUUID } from "node:crypto";
import type {
  HandlerRegistry,
  TaskHandlerContext,
} from "../scheduler/handlers.ts";
import { runAgent } from "../agent/loop.ts";
import { silentRenderer } from "../agent/render.ts";
import { setSessionHiddenFromChat } from "../memory/session_visibility.ts";
import { getProject } from "../memory/projects.ts";
import { getSystemUserId } from "../auth/seed.ts";
import { resolvePrompt } from "../prompts/resolve.ts";
import { registry as toolRegistry } from "../tools/index.ts";
import { errorMessage } from "../util/error.ts";
import {
  selectPendingDefinitions,
  setLlmError,
  setLlmGenerating,
  setLlmResult,
} from "../memory/kb_definitions.ts";
import { extractDefinitionJson } from "../server/kb_routes.ts";

export const KB_AUTO_GENERATE_HANDLER = "kb.auto_generate_scan";

const MAX_CONCURRENT = 3;

export async function kbAutoGenerateHandler(
  ctx: TaskHandlerContext,
): Promise<void> {
  const { db, queue, cfg } = ctx;
  const pending = selectPendingDefinitions(db);
  if (pending.length === 0) return;

  const batch = pending.slice(0, MAX_CONCURRENT);
  const systemUserId = getSystemUserId(db);

  for (const cand of batch) {
    if (!setLlmGenerating(db, cand.id)) continue; // another tick won the race

    const userId = cand.created_by ?? systemUserId;
    const project = getProject(db, cand.project);
    const projectContext = project
      ? (project.description?.trim() || project.name).trim()
      : cand.project;
    const userPrompt =
      cand.is_project_dependent !== 0
        ? `Project: ${cand.project}\nProject context: ${projectContext}\n\nDefine the term (blend with project context when forming search queries): "${cand.term}"`
        : `Define the term: "${cand.term}"`;

    const sessionId = `kb-def-${randomUUID()}`;
    setSessionHiddenFromChat(db, userId, sessionId, true);

    void queue.log({
      topic: "kb",
      kind: "definition.generate.auto",
      userId,
      data: { id: cand.id, project: cand.project, term: cand.term },
    });

    try {
      const answer = await runAgent({
        prompt: userPrompt,
        sessionId,
        userId,
        project: cand.project,
        llmCfg: cfg.llm,
        embedCfg: cfg.embed,
        memoryCfg: cfg.memory,
        agentCfg: cfg.agent,
        webCfg: cfg.web,
        tools: toolRegistry,
        db,
        queue,
        renderer: silentRenderer(),
        systemPromptOverride: resolvePrompt("kb.definition", {
          project: cand.project,
        }),
        originAutomation: true,
      });

      const parsed = extractDefinitionJson(answer);
      if (!parsed) {
        setLlmError(db, cand.id, "model did not return a valid JSON block");
        void queue.log({
          topic: "kb",
          kind: "definition.generate.parse_error",
          data: { id: cand.id, project: cand.project, term: cand.term },
        });
      } else {
        setLlmResult(db, cand.id, parsed);
        void queue.log({
          topic: "kb",
          kind: "definition.generate.done",
          data: {
            id: cand.id,
            project: cand.project,
            term: cand.term,
            sources: parsed.sources.length,
          },
        });
      }
    } catch (e) {
      const msg = errorMessage(e);
      try {
        setLlmError(db, cand.id, msg);
      } catch {
        // swallow — DB may already be closed during test teardown
      }
      void queue.log({
        topic: "kb",
        kind: "definition.generate.error",
        data: { id: cand.id, project: cand.project, term: cand.term },
        error: msg,
      });
    }
  }
}

export function registerKbAutoGenerate(registry: HandlerRegistry): void {
  registry.register(KB_AUTO_GENERATE_HANDLER, kbAutoGenerateHandler);
}
