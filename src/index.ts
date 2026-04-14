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
import { randomUUID } from "node:crypto";

function parseArgs(argv: string[]): { prompt: string; session?: string; hideReasoning: boolean } {
  const args = argv.slice(2);
  let session: string | undefined;
  let hideReasoning = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      session = args[++i];
    } else if (args[i] === "--hide-reasoning") {
      hideReasoning = true;
    } else {
      rest.push(args[i]!);
    }
  }

  return { prompt: rest.join(" ").trim(), session, hideReasoning };
}

async function main(argv: string[]): Promise<number> {
  // `bunny serve [--port=NNNN]` — start the web UI server instead of a CLI turn.
  if (argv[2] === "serve") {
    await startServer({ port: parsePortFlag(argv) });
    await new Promise<void>(() => {}); // Block forever — Bun.serve runs in the background.
    return 0;
  }

  const { prompt, session, hideReasoning } = parseArgs(argv);

  if (!prompt) {
    process.stderr.write("usage: bunny [--session <id>] [--hide-reasoning] <prompt>\n       bunny serve [--port=3000]\n");
    return 2;
  }

  const cfg = loadConfig();
  const sessionId = session ?? cfg.sessionId ?? randomUUID();

  // Ensure state directory exists.
  const home = paths.home();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });

  const db = await getDb({ embedDim: cfg.embed.dim });
  const queue = createBunnyQueue(db);
  const renderer = createRenderer({
    reasoningMode: hideReasoning ? "hidden" : cfg.render.reasoning,
    forceColor: cfg.render.color,
  });

  try {
    await runAgent({
      prompt,
      sessionId,
      llmCfg: cfg.llm,
      embedCfg: cfg.embed,
      memoryCfg: cfg.memory,
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
