#!/usr/bin/env bun
/**
 * Bunny CLI entrypoint.
 *
 * Usage:
 *   bunny <prompt>
 *   bunny --session <id> <prompt>
 *   bunny --hide-reasoning <prompt>
 *   bunny serve [--port=3000]
 *
 * State is stored in $BUNNY_HOME (default: ./.bunny/).
 * Configure via bunny.config.toml or environment variables.
 */

import { loadConfig } from "./config.ts";
import { paths } from "./paths.ts";
import { getDb } from "./memory/db.ts";
import { errorMessage } from "./util/error.ts";
import { createBunnyQueue } from "./queue/bunqueue.ts";
import { createRenderer } from "./agent/render.ts";
import { runAgent } from "./agent/loop.ts";
import { registry } from "./tools/index.ts";
import { startServer, parsePortFlag } from "./server/index.ts";
import { mkdirSync, existsSync } from "node:fs";
import { ensureSeedUsers, getSystemUserId } from "./auth/seed.ts";
import { validateApiKey } from "./auth/apikeys.ts";
import {
  ensureProject,
  getSessionProject,
  validateProjectName,
} from "./memory/projects.ts";
import { ensureProjectDir } from "./memory/project_assets.ts";
import { ensureDefaultAgent } from "./memory/agents_seed.ts";
import { linkAgentToProject } from "./memory/agents.ts";

function parseArgs(argv: string[]): {
  prompt: string;
  session?: string;
  hideReasoning: boolean;
  apiKey?: string;
  project?: string;
} {
  const args = argv.slice(2);
  let session: string | undefined;
  let apiKey: string | undefined;
  let project: string | undefined;
  let hideReasoning = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      session = args[++i]?.trim() || undefined;
    } else if (args[i] === "--api-key" && i + 1 < args.length) {
      apiKey = args[++i]?.trim() || undefined;
    } else if (args[i] === "--project" && i + 1 < args.length) {
      project = args[++i]?.trim() || undefined;
    } else if (args[i] === "--hide-reasoning") {
      hideReasoning = true;
    } else {
      rest.push(args[i]!);
    }
  }

  return {
    prompt: rest.join(" ").trim(),
    session,
    hideReasoning,
    apiKey,
    project,
  };
}

async function main(argv: string[]): Promise<number> {
  // `bunny serve [--port=NNNN]` — start the web UI server instead of a CLI turn.
  if (argv[2] === "serve") {
    await startServer({ port: parsePortFlag(argv) });
    await new Promise<void>(() => {}); // Block forever — Bun.serve runs in the background.
    return 0;
  }

  const {
    prompt,
    session,
    hideReasoning,
    apiKey,
    project: projectArg,
  } = parseArgs(argv);

  if (!prompt) {
    process.stderr.write(
      "usage: bunny [--session <id>] [--project <name>] [--hide-reasoning] [--api-key <key>] <prompt>\n" +
        "       bunny serve [--port=3000]\n",
    );
    return 2;
  }

  const cfg = loadConfig();
  const sessionId = session ?? cfg.sessionId ?? crypto.randomUUID();

  // Ensure state directory exists.
  const home = paths.home();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });

  const db = await getDb({ embedDim: cfg.embed.dim });
  await ensureSeedUsers(db, cfg.auth);

  // Resolve the caller: explicit API key → user; otherwise the `system` user.
  const rawKey = apiKey ?? process.env["BUNNY_API_KEY"];
  let userId = getSystemUserId(db);
  if (rawKey) {
    const match = await validateApiKey(db, rawKey);
    if (!match) {
      process.stderr.write("error: invalid or expired API key\n");
      return 1;
    }
    userId = match.userId;
  }

  // Resolve the project: explicit --project wins if no existing session context;
  // otherwise derive from the session (error on mismatch). The fallback default
  // comes from `[agent] default_project` in `bunny.config.toml`.
  const configuredDefault = validateProjectName(cfg.agent.defaultProject);
  let project: string;
  try {
    const normalisedArg = projectArg
      ? validateProjectName(projectArg)
      : undefined;
    const existing = getSessionProject(db, sessionId);
    if (existing !== null) {
      if (normalisedArg && normalisedArg !== existing) {
        process.stderr.write(
          `error: session '${sessionId}' belongs to project '${existing}', refusing to run under '${normalisedArg}'\n`,
        );
        return 1;
      }
      project = existing;
    } else {
      project = normalisedArg ?? configuredDefault;
    }
    // Auto-create DB row + on-disk directory on first use.
    ensureProject(db, project, userId);
    ensureProjectDir(project);
  } catch (e) {
    process.stderr.write(`error: ${errorMessage(e)}\n`);
    return 1;
  }

  const queue = createBunnyQueue(db);

  // Seed the default agent (idempotent) and link it to the active project so
  // every CLI turn resolves a named agent.
  ensureDefaultAgent(db, cfg.agent, queue);
  try {
    linkAgentToProject(db, project, cfg.agent.defaultAgent);
  } catch {
    // Best-effort — the boot seed will catch this on the next run.
  }

  const renderer = createRenderer({
    reasoningMode: hideReasoning ? "hidden" : cfg.render.reasoning,
    forceColor: cfg.render.color,
  });

  try {
    await runAgent({
      prompt,
      sessionId,
      userId,
      project,
      agent: cfg.agent.defaultAgent,
      llmCfg: cfg.llm,
      embedCfg: cfg.embed,
      memoryCfg: cfg.memory,
      agentCfg: cfg.agent,
      tools: registry,
      db,
      queue,
      renderer,
    });
  } catch (e) {
    renderer.onError(errorMessage(e));
    await queue.close();
    return 1;
  }

  await queue.close();
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
