/**
 * Card-run orchestrator.
 *
 * `runCard` spawns an async, detached agent execution for a board card and
 * returns immediately with the new run-id and session-id. The agent's normal
 * SSE output is mirrored into an in-memory **fanout** so the
 * `/api/cards/:id/runs/:runId/stream` endpoint can subscribe live; the same
 * fanout buffers all events so a late subscriber still gets the full output.
 *
 * The exported `runCard` function is the single entry point — both the
 * `POST /api/cards/:id/run` HTTP handler and (in a future PR) a scheduled
 * task ticker call it. The trigger is recorded on the run row via
 * `triggerKind` so the board UI can distinguish manual vs. scheduled runs.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createSseRenderer,
  finishSse,
  type SseSink,
} from "../agent/render_sse.ts";
import { errorMessage } from "../util/error.ts";
import {
  clearAutoRun,
  getCard,
  moveCard,
  updateCard,
} from "../memory/board_cards.ts";
import { getSwimlane } from "../memory/board_swimlanes.ts";
import { isAgentLinkedToProject } from "../memory/agents.ts";
import {
  createRun,
  getRun,
  markRunDone,
  markRunError,
  type CardRun,
  type RunTriggerKind,
} from "../memory/board_runs.ts";

/** One subscriber's view of a fanout. */
export interface RunFanout {
  runId: number;
  /** Replay buffer (raw SSE-encoded chunks). */
  buffer: Uint8Array[];
  subscribers: Set<SseSink>;
  closed: boolean;
}

const fanouts = new Map<number, RunFanout>();

export function getRunFanout(runId: number): RunFanout | undefined {
  return fanouts.get(runId);
}

/** Subscribe to a live run. The buffered history is flushed first. Returns
 * an unsubscribe fn. If the run has already finished, the buffer is replayed
 * and the sink is closed immediately by the caller after the flush. */
export function subscribeToRun(runId: number, sink: SseSink): () => void {
  const fan = fanouts.get(runId);
  if (!fan) return () => undefined;
  for (const chunk of fan.buffer) sink.enqueue(chunk);
  if (fan.closed) {
    sink.close();
    return () => undefined;
  }
  fan.subscribers.add(sink);
  return () => fan.subscribers.delete(sink);
}

function makeFanoutSink(fan: RunFanout): SseSink {
  return {
    enqueue(chunk) {
      if (fan.closed) return;
      fan.buffer.push(chunk);
      for (const sub of fan.subscribers) sub.enqueue(chunk);
    },
    close() {
      if (fan.closed) return;
      fan.closed = true;
      for (const sub of fan.subscribers) sub.close();
      fan.subscribers.clear();
      // Drop fanout from the registry after a short grace window so brand-new
      // subscribers (e.g. UI that opens the stream right after the response)
      // can still replay the buffer once.
      setTimeout(() => fanouts.delete(fan.runId), 60_000).unref?.();
    },
  };
}

function autoMoveToNextLane(db: Database, cardId: number): void {
  const fresh = getCard(db, cardId);
  if (!fresh) return;
  const currentLane = getSwimlane(db, fresh.swimlaneId);
  if (!currentLane?.nextSwimlaneId) return;
  const nextLane = getSwimlane(db, currentLane.nextSwimlaneId);
  if (!nextLane || nextLane.project !== fresh.project) return;
  moveCard(db, fresh.id, { swimlaneId: nextLane.id });
  if (nextLane.defaultAssigneeUserId || nextLane.defaultAssigneeAgent) {
    updateCard(db, fresh.id, {
      assigneeUserId: nextLane.defaultAssigneeUserId,
      assigneeAgent: nextLane.defaultAssigneeAgent,
      autoRun: nextLane.autoRun && !!nextLane.defaultAssigneeAgent,
    });
  }
}

const encoder = new TextEncoder();
function sendCardEvent(sink: SseSink, payload: object): void {
  sink.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

export interface RunCardOpts {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
  tools: ToolRegistry;
  cardId: number;
  agent?: string;
  triggeredBy: string;
  triggerKind?: RunTriggerKind;
  /** Reuse an existing session (re-run) instead of spinning up a new one. */
  sessionId?: string;
}

export interface RunCardResult {
  run: CardRun;
  sessionId: string;
}

/**
 * Start a card-run. Returns immediately; the actual `runAgent` call runs in
 * a detached promise and pushes events into the in-memory fanout.
 */
export async function runCard(opts: RunCardOpts): Promise<RunCardResult> {
  const card = getCard(opts.db, opts.cardId);
  if (!card) throw new Error(`card ${opts.cardId} not found`);

  const agentName = opts.agent ?? card.assigneeAgent;
  if (!agentName)
    throw new Error("card has no agent assigned and no agent override given");
  if (!isAgentLinkedToProject(opts.db, card.project, agentName)) {
    throw new Error(
      `agent '${agentName}' is not available in project '${card.project}'`,
    );
  }

  // Prevent scheduler re-queue while a run is pending.
  clearAutoRun(opts.db, card.id);

  const sessionId = opts.sessionId ?? randomUUID();
  const run = createRun(opts.db, {
    cardId: opts.cardId,
    sessionId,
    agent: agentName,
    triggeredBy: opts.triggeredBy,
    triggerKind: opts.triggerKind ?? "manual",
    status: "running",
  });

  const fan: RunFanout = {
    runId: run.id,
    buffer: [],
    subscribers: new Set(),
    closed: false,
  };
  fanouts.set(run.id, fan);
  const sink = makeFanoutSink(fan);
  sendCardEvent(sink, {
    type: "card_run_started",
    cardId: card.id,
    runId: run.id,
    sessionId,
  });

  const renderer = createSseRenderer(sink, { author: agentName });
  const prompt =
    card.title + (card.description ? `\n\n${card.description}` : "");

  // Detached: caller gets `RunCardResult` immediately; the agent runs in the
  // background and streams into the fanout.
  void (async () => {
    try {
      const finalAnswer = await runAgent({
        prompt,
        sessionId,
        userId: opts.triggeredBy,
        project: card.project,
        agent: agentName,
        llmCfg: opts.cfg.llm,
        embedCfg: opts.cfg.embed,
        memoryCfg: opts.cfg.memory,
        agentCfg: opts.cfg.agent,
        webCfg: opts.cfg.web,
        tools: opts.tools,
        db: opts.db,
        queue: opts.queue,
        renderer,
      });
      markRunDone(opts.db, run.id, { finalAnswer });
      autoMoveToNextLane(opts.db, card.id);
      sendCardEvent(sink, {
        type: "card_run_finished",
        cardId: card.id,
        runId: run.id,
        status: "done",
        finalAnswer,
      });
    } catch (e) {
      const msg = errorMessage(e);
      markRunError(opts.db, run.id, msg);
      renderer.onError(msg);
      sendCardEvent(sink, {
        type: "card_run_finished",
        cardId: card.id,
        runId: run.id,
        status: "error",
        error: msg,
      });
    } finally {
      finishSse(sink);
    }
  })();

  return { run, sessionId };
}

/** Test/diagnostic helper: wait until a run leaves the running state. */
export async function awaitRunCompletion(
  db: Database,
  runId: number,
  timeoutMs = 10_000,
): Promise<CardRun> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getRun(db, runId);
    if (!run) throw new Error(`run ${runId} disappeared`);
    if (run.status !== "running" && run.status !== "queued") return run;
    await Bun.sleep(10);
  }
  throw new Error(`run ${runId} did not complete within ${timeoutMs}ms`);
}
