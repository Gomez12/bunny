import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/memory/db.ts";
import {
  createDiaryEntry,
  getDiaryEntry,
  listDiaryEntries,
  setCorrecting,
  setCorrectionDone,
  setCorrectionError,
  setTranscribing,
  setTranscriptionDone,
  setTranscriptionError,
  deleteDiaryEntry,
  updateDiaryEntry,
} from "../../src/memory/diary.ts";
import { createProject } from "../../src/memory/projects.ts";
import { createUser } from "../../src/auth/users.ts";
import type { Database } from "bun:sqlite";

let tmp: string;
let db: Database;

async function setup() {
  tmp = mkdtempSync(join(tmpdir(), "bunny-diary-"));
  db = await openDb(join(tmp, "test.sqlite"));
  createProject(db, { name: "testproject", visibility: "public" });
  const alice = await createUser(db, {
    username: "alice",
    password: "pass",
    role: "user",
  });
  return alice.id;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("diary CRUD", () => {
  test("create and get", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, {
      project: "testproject",
      userId,
      language: "nl",
      title: "Test entry",
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.title).toBe("Test entry");
    expect(entry.language).toBe("nl");
    expect(entry.transcriptionStatus).toBe("idle");

    const fetched = getDiaryEntry(db, entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test entry");
  });

  test("list returns own entries only", async () => {
    const userId = await setup();
    const bob = await createUser(db, { username: "bob", password: "pass", role: "user" });
    const bobId = bob.id;

    createDiaryEntry(db, { project: "testproject", userId, title: "Alice entry" });
    createDiaryEntry(db, { project: "testproject", userId: bobId, title: "Bob entry" });

    const aliceList = listDiaryEntries(db, "testproject", userId);
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]!.title).toBe("Alice entry");

    const bobList = listDiaryEntries(db, "testproject", bobId);
    expect(bobList).toHaveLength(1);
  });

  test("updateDiaryEntry patches title and language", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    const updated = updateDiaryEntry(db, entry.id, {
      title: "Updated title",
      language: "en",
    });
    expect(updated!.title).toBe("Updated title");
    expect(updated!.language).toBe("en");
  });

  test("soft delete hides from list", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    expect(listDiaryEntries(db, "testproject", userId)).toHaveLength(1);

    deleteDiaryEntry(db, entry.id, userId);
    expect(listDiaryEntries(db, "testproject", userId)).toHaveLength(0);
    expect(getDiaryEntry(db, entry.id)).toBeNull();
  });
});

describe("transcription status machine", () => {
  test("idle → transcribing → done", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    expect(entry.transcriptionStatus).toBe("idle");

    const claimed = setTranscribing(db, entry.id);
    expect(claimed).toBe(true);
    expect(getDiaryEntry(db, entry.id)!.transcriptionStatus).toBe("transcribing");

    setTranscriptionDone(db, entry.id, "hallo wereld");
    const done = getDiaryEntry(db, entry.id)!;
    expect(done.transcriptionStatus).toBe("done");
    expect(done.transcription).toBe("hallo wereld");
    expect(done.transcribedAt).toBeGreaterThan(0);
  });

  test("idle → transcribing → error", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });

    setTranscribing(db, entry.id);
    setTranscriptionError(db, entry.id, "whisper.cpp exited with code 1");
    const errored = getDiaryEntry(db, entry.id)!;
    expect(errored.transcriptionStatus).toBe("error");
    expect(errored.transcriptionError).toBe("whisper.cpp exited with code 1");
  });

  test("setTranscribing race guard: concurrent claim returns false", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });

    const first = setTranscribing(db, entry.id);
    const second = setTranscribing(db, entry.id);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("setTranscribing allows re-claim after error", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });

    setTranscribing(db, entry.id);
    setTranscriptionError(db, entry.id, "timeout");

    const reclaimed = setTranscribing(db, entry.id);
    expect(reclaimed).toBe(true);
  });
});

describe("LLM correction status machine", () => {
  test("setTranscriptionDone stores raw in both transcription and rawTranscription", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    setTranscribing(db, entry.id);
    setTranscriptionDone(db, entry.id, "hallo wreld dit is een test");

    const done = getDiaryEntry(db, entry.id)!;
    expect(done.transcription).toBe("hallo wreld dit is een test");
    expect(done.rawTranscription).toBe("hallo wreld dit is een test");
    expect(done.correctionStatus).toBe("idle");
  });

  test("setCorrectionDone replaces transcription but preserves rawTranscription", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    setTranscribing(db, entry.id);
    setTranscriptionDone(db, entry.id, "hallo wreld dit is een test");
    setCorrecting(db, entry.id);
    setCorrectionDone(db, entry.id, "Hallo wereld, dit is een test");

    const corrected = getDiaryEntry(db, entry.id)!;
    expect(corrected.transcription).toBe("Hallo wereld, dit is een test");
    expect(corrected.rawTranscription).toBe("hallo wreld dit is een test");
    expect(corrected.correctionStatus).toBe("done");
  });

  test("setCorrectionError keeps transcription as raw fallback", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    setTranscribing(db, entry.id);
    setTranscriptionDone(db, entry.id, "ruwe tekst");
    setCorrecting(db, entry.id);
    setCorrectionError(db, entry.id);

    const errored = getDiaryEntry(db, entry.id)!;
    expect(errored.transcription).toBe("ruwe tekst");
    expect(errored.rawTranscription).toBe("ruwe tekst");
    expect(errored.correctionStatus).toBe("error");
  });

  test("retranscribe resets correctionStatus to idle", async () => {
    const userId = await setup();
    const entry = createDiaryEntry(db, { project: "testproject", userId });
    setTranscribing(db, entry.id);
    setTranscriptionDone(db, entry.id, "eerste keer");
    setCorrectionDone(db, entry.id, "eerste keer gecorrigeerd");

    // Second transcription run
    setTranscribing(db, entry.id);
    setTranscriptionDone(db, entry.id, "tweede keer");

    const refreshed = getDiaryEntry(db, entry.id)!;
    expect(refreshed.rawTranscription).toBe("tweede keer");
    expect(refreshed.correctionStatus).toBe("idle");
  });

  test("generated title updates title field, does not overwrite existing title", async () => {
    const userId = await setup();
    const withTitle = createDiaryEntry(db, {
      project: "testproject",
      userId,
      title: "Handmatige titel",
    });
    const withoutTitle = createDiaryEntry(db, { project: "testproject", userId });

    updateDiaryEntry(db, withoutTitle.id, { title: "Gegenereerde titel" });
    const updated = getDiaryEntry(db, withoutTitle.id)!;
    expect(updated.title).toBe("Gegenereerde titel");

    // Existing title should be unchanged
    const existing = getDiaryEntry(db, withTitle.id)!;
    expect(existing.title).toBe("Handmatige titel");
  });
});
