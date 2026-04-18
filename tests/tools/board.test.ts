import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createAgent, linkAgentToProject } from "../../src/memory/agents.ts";
import { listSwimlanes } from "../../src/memory/board_swimlanes.ts";
import { listCards, getCard } from "../../src/memory/board_cards.ts";
import { makeBoardTools, BOARD_TOOL_NAMES } from "../../src/tools/board.ts";

let tmp: string;
let db: Database;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-board-tools-"));
  db = await openDb(join(tmp, "test.sqlite"));
  const now = Date.now();
  db.run(
    `INSERT INTO users(id, username, password_hash, role, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', 'user', ?, ?)`,
    [now, now],
  );
  createProject(db, { name: "alpha", createdBy: "u1" });
});

afterEach(() => {
  db.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function tools() {
  const arr = makeBoardTools({ db, project: "alpha", userId: "u1" });
  return Object.fromEntries(arr.map((t) => [t.name, t.handler]));
}

describe("board tools — schema", () => {
  test("BOARD_TOOL_NAMES matches makeBoardTools output", () => {
    const names = makeBoardTools({ db, project: "alpha", userId: "u1" }).map(
      (t) => t.name,
    );
    expect(names.sort()).toEqual([...BOARD_TOOL_NAMES].sort());
  });
});

describe("board_list", () => {
  test("returns lanes + active cards by default", async () => {
    const lane = listSwimlanes(db, "alpha")[0]!;
    const handlers = tools();
    const created = await handlers["board_create_card"]!({
      title: "first",
      lane: lane.name,
    });
    expect(created.ok).toBe(true);
    const out = await handlers["board_list"]!({});
    expect(out.ok).toBe(true);
    const data = JSON.parse(out.output) as {
      swimlanes: unknown[];
      cards: { title: string }[];
    };
    expect(data.swimlanes.length).toBe(3);
    expect(data.cards.map((c) => c.title)).toContain("first");
  });

  test("filters by lane name", async () => {
    const [todo, doing] = listSwimlanes(db, "alpha");
    const handlers = tools();
    await handlers["board_create_card"]!({ title: "a", lane_id: todo!.id });
    await handlers["board_create_card"]!({ title: "b", lane_id: doing!.id });
    const out = await handlers["board_list"]!({ lane: "Doing" });
    const data = JSON.parse(out.output) as { cards: { title: string }[] };
    expect(data.cards.map((c) => c.title)).toEqual(["b"]);
  });
});

describe("board_create_card", () => {
  test("requires title", async () => {
    const r = await tools()["board_create_card"]!({ lane: "Todo" });
    expect(r.ok).toBe(false);
  });

  test("rejects unknown lane", async () => {
    const r = await tools()["board_create_card"]!({
      title: "x",
      lane: "ghost",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found/);
  });

  test("rejects unlinked agent", async () => {
    createAgent(db, { name: "ghost" });
    const r = await tools()["board_create_card"]!({
      title: "x",
      lane: "Todo",
      assignee_agent: "ghost",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not linked/);
  });

  test("succeeds with linked agent", async () => {
    createAgent(db, { name: "researcher" });
    linkAgentToProject(db, "alpha", "researcher");
    const r = await tools()["board_create_card"]!({
      title: "x",
      lane: "Todo",
      assignee_agent: "researcher",
    });
    expect(r.ok).toBe(true);
    const cards = listCards(db, "alpha");
    expect(cards[0]!.assigneeAgent).toBe("researcher");
  });
});

describe("board_move_card", () => {
  test("moves between lanes by name", async () => {
    const [todo, doing] = listSwimlanes(db, "alpha");
    const created = await tools()["board_create_card"]!({
      title: "x",
      lane_id: todo!.id,
    });
    const id = (JSON.parse(created.output) as { id: number }).id;
    const moved = await tools()["board_move_card"]!({
      card_id: id,
      lane: "Doing",
    });
    expect(moved.ok).toBe(true);
    expect(getCard(db, id)!.swimlaneId).toBe(doing!.id);
  });

  test("refuses cross-project access", async () => {
    createProject(db, { name: "beta" });
    const betaLane = listSwimlanes(db, "beta")[0]!;
    const r = await tools()["board_get_card"]!({ card_id: betaLane.id }); // any id from another project
    expect(r.ok).toBe(false);
  });
});

describe("board_update_card", () => {
  test("clears assignee with empty string", async () => {
    createAgent(db, { name: "a1" });
    linkAgentToProject(db, "alpha", "a1");
    const created = await tools()["board_create_card"]!({
      title: "x",
      lane: "Todo",
      assignee_agent: "a1",
    });
    const id = (JSON.parse(created.output) as { id: number }).id;
    const cleared = await tools()["board_update_card"]!({
      card_id: id,
      assignee_agent: "",
    });
    expect(cleared.ok).toBe(true);
    expect(getCard(db, id)!.assigneeAgent).toBeNull();
  });
});

describe("board_archive_card", () => {
  test("archives and disappears from default board_list", async () => {
    const created = await tools()["board_create_card"]!({
      title: "x",
      lane: "Todo",
    });
    const id = (JSON.parse(created.output) as { id: number }).id;
    await tools()["board_archive_card"]!({ card_id: id });
    const list = await tools()["board_list"]!({});
    const data = JSON.parse(list.output) as { cards: unknown[] };
    expect(data.cards).toHaveLength(0);
  });
});
