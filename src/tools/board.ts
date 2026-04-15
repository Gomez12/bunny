/**
 * Board tools — closure-bound CRUD on the active project's kanban board.
 *
 * Like {@link ./call_agent.ts}, these tools need live runtime context (db,
 * project name, the user id of the invoking turn) so they're not registered
 * on the shared singleton. Each `runAgent` call builds them via
 * {@link makeBoardTools} and splices them into the per-run subset registry.
 *
 * The closure binds the project, so an agent in project "alpha" can never
 * touch a card in project "beta" — the project name is *not* a tool argument.
 *
 * Lanes can be referenced by name (e.g. "Doing") or by numeric id; cards are
 * always identified by id. Outputs are compact JSON strings so the model can
 * parse them on the next turn without prose handling.
 */

import type { Database } from "bun:sqlite";
import type { JsonSchemaObject } from "../llm/types.ts";
import type { ToolHandler, ToolResult } from "./registry.ts";
import {
  archiveCard,
  createCard,
  getCard,
  listCards,
  moveCard,
  updateCard,
  type Card,
} from "../memory/board_cards.ts";
import { listSwimlanes, type Swimlane } from "../memory/board_swimlanes.ts";
import { isAgentLinkedToProject } from "../memory/agents.ts";

export const BOARD_TOOL_NAMES = [
  "board_list",
  "board_get_card",
  "board_create_card",
  "board_update_card",
  "board_move_card",
  "board_archive_card",
] as const;
export type BoardToolName = (typeof BOARD_TOOL_NAMES)[number];

export interface BoardToolContext {
  db: Database;
  project: string;
  /** User id stamped onto cards the agent creates. */
  userId: string;
}

export interface BoardToolDescriptor {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  handler: ToolHandler;
}

export function makeBoardTools(ctx: BoardToolContext): BoardToolDescriptor[] {
  return [
    boardListTool(ctx),
    boardGetCardTool(ctx),
    boardCreateCardTool(ctx),
    boardUpdateCardTool(ctx),
    boardMoveCardTool(ctx),
    boardArchiveCardTool(ctx),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ok(value: unknown): ToolResult {
  return { ok: true, output: typeof value === "string" ? value : JSON.stringify(value) };
}
function err(msg: string): ToolResult {
  return { ok: false, output: msg, error: msg };
}

function getString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function getNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function resolveLane(
  ctx: BoardToolContext,
  args: Record<string, unknown>,
  key = "lane",
): Swimlane | { error: string } {
  const lanes = listSwimlanes(ctx.db, ctx.project);
  const id = getNumber(args, `${key}_id`);
  if (id !== undefined) {
    const found = lanes.find((l) => l.id === id);
    return found ?? { error: `lane ${id} not found in project '${ctx.project}'` };
  }
  const name = getString(args, key);
  if (name) {
    const lower = name.toLowerCase();
    const found = lanes.find((l) => l.name.toLowerCase() === lower);
    return found ?? {
      error: `lane '${name}' not found. Available: ${lanes.map((l) => l.name).join(", ")}`,
    };
  }
  return { error: `provide either '${key}' (name) or '${key}_id'` };
}

function summariseCard(c: Card, lanesById: Map<number, string>): Record<string, unknown> {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    lane: lanesById.get(c.swimlaneId) ?? null,
    swimlaneId: c.swimlaneId,
    assigneeUserId: c.assigneeUserId,
    assigneeAgent: c.assigneeAgent,
    createdBy: c.createdBy,
    archived: c.archivedAt !== null,
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────

function boardListTool(ctx: BoardToolContext): BoardToolDescriptor {
  return {
    name: "board_list",
    description:
      "List the swimlanes and active (non-archived) cards on the current project's kanban board.",
    parameters: {
      type: "object",
      properties: {
        include_archived: {
          type: "boolean",
          description: "Include archived cards in the result. Defaults to false.",
        },
        lane: {
          type: "string",
          description:
            "Optional lane name. When set, only cards in this lane are returned.",
        },
      },
    },
    handler: (args) => {
      const lanes = listSwimlanes(ctx.db, ctx.project);
      const lanesById = new Map(lanes.map((l) => [l.id, l.name]));
      const includeArchived = args["include_archived"] === true;
      let cards = listCards(ctx.db, ctx.project, { includeArchived });
      const laneFilter = getString(args, "lane");
      if (laneFilter) {
        const lowered = laneFilter.toLowerCase();
        const lane = lanes.find((l) => l.name.toLowerCase() === lowered);
        if (!lane) return err(`lane '${laneFilter}' not found`);
        cards = cards.filter((c) => c.swimlaneId === lane.id);
      }
      return ok({
        project: ctx.project,
        swimlanes: lanes.map((l) => ({ id: l.id, name: l.name, position: l.position })),
        cards: cards.map((c) => summariseCard(c, lanesById)),
      });
    },
  };
}

function boardGetCardTool(ctx: BoardToolContext): BoardToolDescriptor {
  return {
    name: "board_get_card",
    description: "Fetch one card by id, including full description and assignee.",
    parameters: {
      type: "object",
      properties: { card_id: { type: "number", description: "Card id." } },
      required: ["card_id"],
    },
    handler: (args) => {
      const id = getNumber(args, "card_id");
      if (id === undefined) return err("missing 'card_id'");
      const card = getCard(ctx.db, id);
      if (!card || card.project !== ctx.project) return err(`card ${id} not found in this project`);
      const lanes = listSwimlanes(ctx.db, ctx.project);
      const lanesById = new Map(lanes.map((l) => [l.id, l.name]));
      return ok(summariseCard(card, lanesById));
    },
  };
}

function boardCreateCardTool(ctx: BoardToolContext): BoardToolDescriptor {
  return {
    name: "board_create_card",
    description:
      "Create a new card on the board. Specify the lane by name ('lane') or id ('lane_id'). Optionally assign to an agent linked to this project.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title (required, non-empty)." },
        description: { type: "string", description: "Card description / body. Optional." },
        lane: { type: "string", description: "Swimlane name (case-insensitive)." },
        lane_id: { type: "number", description: "Swimlane numeric id (alternative to 'lane')." },
        assignee_agent: {
          type: "string",
          description: "Optional agent name to assign the card to. Must be linked to this project.",
        },
      },
      required: ["title"],
    },
    handler: (args) => {
      const title = getString(args, "title");
      if (!title) return err("'title' is required");
      const lane = resolveLane(ctx, args);
      if ("error" in lane) return err(lane.error);
      const assigneeAgent = getString(args, "assignee_agent");
      if (assigneeAgent && !isAgentLinkedToProject(ctx.db, ctx.project, assigneeAgent)) {
        return err(`agent '${assigneeAgent}' is not linked to project '${ctx.project}'`);
      }
      try {
        const card = createCard(ctx.db, {
          project: ctx.project,
          swimlaneId: lane.id,
          title,
          description: getString(args, "description") ?? "",
          assigneeAgent: assigneeAgent ?? null,
          createdBy: ctx.userId,
        });
        const lanes = listSwimlanes(ctx.db, ctx.project);
        const lanesById = new Map(lanes.map((l) => [l.id, l.name]));
        return ok(summariseCard(card, lanesById));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function boardUpdateCardTool(ctx: BoardToolContext): BoardToolDescriptor {
  return {
    name: "board_update_card",
    description:
      "Update title, description, or agent-assignee of an existing card. Pass only the fields you want to change.",
    parameters: {
      type: "object",
      properties: {
        card_id: { type: "number", description: "Card id." },
        title: { type: "string" },
        description: { type: "string" },
        assignee_agent: {
          type: "string",
          description:
            "Agent name to assign. Pass an empty string to clear the current assignee.",
        },
      },
      required: ["card_id"],
    },
    handler: (args) => {
      const id = getNumber(args, "card_id");
      if (id === undefined) return err("missing 'card_id'");
      const card = getCard(ctx.db, id);
      if (!card || card.project !== ctx.project) return err(`card ${id} not found in this project`);
      const patch: Parameters<typeof updateCard>[2] = {};
      if (typeof args["title"] === "string") patch.title = args["title"];
      if (typeof args["description"] === "string") patch.description = args["description"];
      if (typeof args["assignee_agent"] === "string") {
        const v = (args["assignee_agent"] as string).trim();
        if (v === "") {
          patch.assigneeAgent = null;
        } else {
          if (!isAgentLinkedToProject(ctx.db, ctx.project, v)) {
            return err(`agent '${v}' is not linked to project '${ctx.project}'`);
          }
          patch.assigneeAgent = v;
        }
      }
      try {
        const updated = updateCard(ctx.db, id, patch);
        const lanes = listSwimlanes(ctx.db, ctx.project);
        const lanesById = new Map(lanes.map((l) => [l.id, l.name]));
        return ok(summariseCard(updated, lanesById));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function boardMoveCardTool(ctx: BoardToolContext): BoardToolDescriptor {
  return {
    name: "board_move_card",
    description: "Move a card to another swimlane (e.g. from 'Todo' to 'Doing').",
    parameters: {
      type: "object",
      properties: {
        card_id: { type: "number", description: "Card id." },
        lane: { type: "string", description: "Target swimlane name." },
        lane_id: { type: "number", description: "Target swimlane id (alternative to 'lane')." },
      },
      required: ["card_id"],
    },
    handler: (args) => {
      const id = getNumber(args, "card_id");
      if (id === undefined) return err("missing 'card_id'");
      const card = getCard(ctx.db, id);
      if (!card || card.project !== ctx.project) return err(`card ${id} not found in this project`);
      const lane = resolveLane(ctx, args);
      if ("error" in lane) return err(lane.error);
      try {
        const moved = moveCard(ctx.db, id, { swimlaneId: lane.id });
        const lanes = listSwimlanes(ctx.db, ctx.project);
        const lanesById = new Map(lanes.map((l) => [l.id, l.name]));
        return ok(summariseCard(moved, lanesById));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function boardArchiveCardTool(ctx: BoardToolContext): BoardToolDescriptor {
  return {
    name: "board_archive_card",
    description: "Soft-archive a card. The card stays in the database but no longer appears on the board.",
    parameters: {
      type: "object",
      properties: { card_id: { type: "number", description: "Card id." } },
      required: ["card_id"],
    },
    handler: (args) => {
      const id = getNumber(args, "card_id");
      if (id === undefined) return err("missing 'card_id'");
      const card = getCard(ctx.db, id);
      if (!card || card.project !== ctx.project) return err(`card ${id} not found in this project`);
      try {
        archiveCard(ctx.db, id);
        return ok({ id, archived: true });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
