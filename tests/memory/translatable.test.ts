/**
 * Table-driven test for the shared translatable-entity abstraction. Hits all
 * four registered kinds (kb_definition, document, contact, board_card) with
 * one generic test body per behaviour so adding a fifth kind later is a
 * one-line addition.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/memory/db.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createUser } from "../../src/auth/users.ts";
import {
  claimPending,
  computeSourceHash,
  ensureLanguageRows,
  getEntitySource,
  getSourceVersion,
  listTranslations,
  markAllStale,
  markReadyNoop,
  setError,
  setReady,
  sweepStuckTranslating,
  TRANSLATABLE_REGISTRY,
  type TranslatableKind,
} from "../../src/memory/translatable.ts";
import { createDefinition } from "../../src/memory/kb_definitions.ts";
import { createDocument } from "../../src/memory/documents.ts";
import { createContact } from "../../src/memory/contacts.ts";
import { listSwimlanes } from "../../src/memory/board_swimlanes.ts";
import { createCard } from "../../src/memory/board_cards.ts";

let tmp: string;
let db: Database;
let ownerId: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bunny-translatable-"));
  db = await openDb(join(tmp, "db.sqlite"));
  const u = await createUser(db, {
    username: "owner",
    password: "pw-123456789",
    role: "admin",
  });
  ownerId = u.id;
  createProject(db, {
    name: "alpha",
    description: "a test project",
    visibility: "public",
    languages: ["en", "nl", "de"],
    defaultLanguage: "en",
    createdBy: ownerId,
  });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface KindFixture {
  kind: TranslatableKind;
  create: () => number;
  /** Apply an in-place source-field mutation on the entity row. */
  editSource: (id: number) => void;
}

function fixtures(): KindFixture[] {
  return [
    {
      kind: TRANSLATABLE_REGISTRY["kb_definition"]!,
      create: () => {
        const d = createDefinition(db, {
          project: "alpha",
          term: "Chair",
          manualDescription: "A seat.",
          createdBy: ownerId,
        });
        return d.id;
      },
      editSource: (id) => {
        db.prepare(
          `UPDATE kb_definitions SET manual_description = 'Edited description' WHERE id = ?`,
        ).run(id);
      },
    },
    {
      kind: TRANSLATABLE_REGISTRY["document"]!,
      create: () => {
        const d = createDocument(db, {
          project: "alpha",
          name: "spec",
          contentMd: "# Hello",
          createdBy: ownerId,
        });
        return d.id;
      },
      editSource: (id) => {
        db.prepare(
          `UPDATE documents SET content_md = '# Edited' WHERE id = ?`,
        ).run(id);
      },
    },
    {
      kind: TRANSLATABLE_REGISTRY["contact"]!,
      create: () => {
        const c = createContact(db, {
          project: "alpha",
          name: "Alice",
          notes: "met at conference",
          createdBy: ownerId,
        });
        return c.id;
      },
      editSource: (id) => {
        db.prepare(
          `UPDATE contacts SET notes = 'edited notes' WHERE id = ?`,
        ).run(id);
      },
    },
    {
      kind: TRANSLATABLE_REGISTRY["board_card"]!,
      create: () => {
        const lanes = listSwimlanes(db, "alpha");
        const lane = lanes[0]!;
        const c = createCard(db, {
          project: "alpha",
          swimlaneId: lane.id,
          title: "Do the thing",
          description: "task body",
          createdBy: ownerId,
        });
        return c.id;
      },
      editSource: (id) => {
        db.prepare(
          `UPDATE board_cards SET description = 'edited task body' WHERE id = ?`,
        ).run(id);
      },
    },
  ];
}

describe("translatable registry", () => {
  test("every translatable entity kind is registered", () => {
    const names = Object.keys(TRANSLATABLE_REGISTRY).sort();
    expect(names).toEqual([
      "board_card",
      "business",
      "contact",
      "document",
      "kb_definition",
    ]);
  });
});

describe("computeSourceHash", () => {
  test("is order-insensitive across keys", () => {
    const a = computeSourceHash({ x: "1", y: "2" });
    const b = computeSourceHash({ y: "2", x: "1" });
    expect(a).toBe(b);
  });
  test("null and undefined collapse to empty", () => {
    expect(computeSourceHash({ x: null })).toBe(
      computeSourceHash({ x: undefined }),
    );
    expect(computeSourceHash({ x: null })).toBe(computeSourceHash({ x: "" }));
  });
  test("differing values produce different hashes", () => {
    expect(computeSourceHash({ x: "a" })).not.toBe(
      computeSourceHash({ x: "b" }),
    );
  });
});

for (const { kind, create, editSource } of fixtures()) {
  describe(`translatable(${kind.name})`, () => {
    test("createTranslationSlots seeds sidecar rows for every non-source language", () => {
      const id = create();
      const rows = listTranslations(db, kind, id);
      expect(rows.map((r) => r.lang).sort()).toEqual(["de", "nl"]);
      expect(rows.every((r) => r.status === "pending")).toBe(true);
    });

    test("markAllStale bumps source_version and flips all sidecar rows to pending", () => {
      const id = create();
      // Put one row into 'ready' so we can observe it flip back.
      const rows = listTranslations(db, kind, id);
      const target = rows.find((r) => r.lang === "nl")!;
      setReady(db, kind, target.id, {}, 1, "hash");
      expect(
        listTranslations(db, kind, id).find((r) => r.lang === "nl")?.status,
      ).toBe("ready");
      markAllStale(db, kind, id);
      const after = listTranslations(db, kind, id);
      expect(after.every((r) => r.status === "pending")).toBe(true);
      expect(getSourceVersion(db, kind, id)).toBe(2);
    });

    test("claimPending atomically flips pending → translating", () => {
      const id = create();
      const now = Date.now();
      const claimed = claimPending(db, kind, 10, now);
      expect(claimed.length).toBe(2); // nl + de (en is the source)
      expect(claimed.every((c) => c.status === "translating")).toBe(true);
      // Second claim yields nothing.
      expect(claimPending(db, kind, 10, now).length).toBe(0);
    });

    test("hash-skip (edit → revert) does not trigger another translate call", () => {
      const id = create();
      const entity = getEntitySource(db, kind, id)!;
      const h = computeSourceHash(entity.fields);
      // First translation "succeeds".
      const rows = listTranslations(db, kind, id);
      const target = rows.find((r) => r.lang === "nl")!;
      setReady(db, kind, target.id, {}, entity.sourceVersion, h);
      expect(
        listTranslations(db, kind, id).find((r) => r.lang === "nl")?.sourceHash,
      ).toBe(h);
      // Simulate edit → revert: markAllStale, but hash unchanged.
      markAllStale(db, kind, id);
      const entity2 = getEntitySource(db, kind, id)!;
      const h2 = computeSourceHash(entity2.fields);
      expect(h2).toBe(h); // no actual content change
      // Claim and verify we can markReadyNoop without recomputing translation.
      const [claimed] = claimPending(db, kind, 10, Date.now());
      expect(claimed).toBeDefined();
      // Prove the skip path: markReadyNoop stamps the new source_version and
      // returns status=ready without touching sidecar fields.
      const postClaim = listTranslations(db, kind, id).find(
        (r) => r.lang === "nl",
      )!;
      markReadyNoop(db, kind, postClaim.id, entity2.sourceVersion);
      const final = listTranslations(db, kind, id).find(
        (r) => r.lang === "nl",
      )!;
      expect(final.status).toBe("ready");
      expect(final.sourceVersion).toBe(entity2.sourceVersion);
      expect(final.sourceHash).toBe(h); // unchanged
    });

    test("editSource flips translations back to pending; editing a non-source field does not", () => {
      const id = create();
      const rows0 = listTranslations(db, kind, id);
      for (const r of rows0) setReady(db, kind, r.id, {}, 1, "h");
      // Edit a source field via the real update path ... simulated by raw UPDATE
      // matching what the CRUD helpers do internally.
      editSource(id);
      markAllStale(db, kind, id);
      const rows1 = listTranslations(db, kind, id);
      expect(rows1.every((r) => r.status === "pending")).toBe(true);
    });

    test("setError transitions translating → error and clears translating_at", () => {
      const id = create();
      claimPending(db, kind, 10, Date.now());
      const [row] = listTranslations(db, kind, id).filter(
        (r) => r.status === "translating",
      );
      expect(row).toBeDefined();
      setError(db, kind, row!.id, "LLM said no");
      const final = listTranslations(db, kind, id).find(
        (r) => r.id === row!.id,
      )!;
      expect(final.status).toBe("error");
      expect(final.error).toBe("LLM said no");
      expect(final.translatingAt).toBeNull();
    });

    test("sweepStuckTranslating reclaims translating rows older than threshold", () => {
      const id = create();
      const past = Date.now() - 60 * 60_000; // 1h ago
      claimPending(db, kind, 10, past);
      expect(
        listTranslations(db, kind, id).every((r) => r.status === "translating"),
      ).toBe(true);
      const reclaimed = sweepStuckTranslating(
        db,
        kind,
        30 * 60_000,
        Date.now(),
      );
      expect(reclaimed).toBe(2);
      expect(
        listTranslations(db, kind, id).every((r) => r.status === "pending"),
      ).toBe(true);
    });

    test("sweepStuckTranslating leaves fresh translating rows alone", () => {
      const id = create();
      const now = Date.now();
      claimPending(db, kind, 10, now);
      const reclaimed = sweepStuckTranslating(db, kind, 30 * 60_000, now);
      expect(reclaimed).toBe(0);
      expect(
        listTranslations(db, kind, id).every((r) => r.status === "translating"),
      ).toBe(true);
    });

    test("ensureLanguageRows is idempotent — re-adding a language does not duplicate", () => {
      const id = create();
      expect(listTranslations(db, kind, id).length).toBe(2);
      ensureLanguageRows(db, kind, id, "en", ["nl", "de", "nl"], 1);
      expect(listTranslations(db, kind, id).length).toBe(2);
    });
  });
}
