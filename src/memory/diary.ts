import type { Database } from "bun:sqlite";
import { registerTrashable, softDelete } from "./trash.ts";

registerTrashable({
  kind: "diary_entry",
  table: "diary_entries",
  nameColumn: "title",
  hasUniqueName: false,
  translationSidecarTable: null,
  translationSidecarFk: null,
});

export type TranscriptionStatus = "idle" | "transcribing" | "done" | "error";
export type CorrectionStatus = "idle" | "correcting" | "done" | "error";

export interface DiaryEntry {
  id: number;
  project: string;
  userId: string;
  title: string;
  audioPath: string | null;
  audioDurationS: number | null;
  audioSizeB: number | null;
  language: string;
  transcription: string | null;
  rawTranscription: string | null;
  transcriptionStatus: TranscriptionStatus;
  transcriptionError: string | null;
  transcribedAt: number | null;
  correctionStatus: CorrectionStatus;
  createdAt: number;
  updatedAt: number;
}

interface DiaryRow {
  id: number;
  project: string;
  user_id: string;
  title: string;
  audio_path: string | null;
  audio_duration_s: number | null;
  audio_size_b: number | null;
  language: string;
  transcription: string | null;
  raw_transcription: string | null;
  transcription_status: string;
  transcription_error: string | null;
  transcribed_at: number | null;
  correction_status: string;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: DiaryRow): DiaryEntry {
  return {
    id: row.id,
    project: row.project,
    userId: row.user_id,
    title: row.title,
    audioPath: row.audio_path,
    audioDurationS: row.audio_duration_s,
    audioSizeB: row.audio_size_b,
    language: row.language,
    transcription: row.transcription,
    rawTranscription: row.raw_transcription ?? null,
    transcriptionStatus: row.transcription_status as TranscriptionStatus,
    transcriptionError: row.transcription_error,
    transcribedAt: row.transcribed_at,
    correctionStatus: (row.correction_status ?? "idle") as CorrectionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDiaryEntries(
  db: Database,
  project: string,
  userId: string,
): DiaryEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM diary_entries
       WHERE project = ? AND user_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(project, userId) as DiaryRow[];
  return rows.map(rowToEntry);
}

export function getDiaryEntry(db: Database, id: number): DiaryEntry | null {
  const row = db
    .prepare(
      `SELECT * FROM diary_entries WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as DiaryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export interface CreateDiaryEntryOpts {
  project: string;
  userId: string;
  language?: string;
  title?: string;
}

export function createDiaryEntry(
  db: Database,
  opts: CreateDiaryEntryOpts,
): DiaryEntry {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO diary_entries
         (project, user_id, created_by, title, language, transcription_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
    )
    .run(
      opts.project,
      opts.userId,
      opts.userId,
      opts.title ?? "",
      opts.language ?? "nl",
      now,
      now,
    );
  return getDiaryEntry(db, Number(info.lastInsertRowid))!;
}

export interface UpdateDiaryEntryPatch {
  title?: string;
  language?: string;
  audioPath?: string;
  audioDurationS?: number;
  audioSizeB?: number;
}

export function updateDiaryEntry(
  db: Database,
  id: number,
  patch: UpdateDiaryEntryPatch,
): DiaryEntry | null {
  const existing = getDiaryEntry(db, id);
  if (!existing) return null;

  const title = patch.title ?? existing.title;
  const language = patch.language ?? existing.language;
  const audioPath =
    patch.audioPath !== undefined ? patch.audioPath : existing.audioPath;
  const audioDurationS =
    patch.audioDurationS !== undefined
      ? patch.audioDurationS
      : existing.audioDurationS;
  const audioSizeB =
    patch.audioSizeB !== undefined ? patch.audioSizeB : existing.audioSizeB;

  db.prepare(
    `UPDATE diary_entries
     SET title = ?, language = ?, audio_path = ?, audio_duration_s = ?,
         audio_size_b = ?, updated_at = ?
     WHERE id = ?`,
  ).run(title, language, audioPath, audioDurationS, audioSizeB, Date.now(), id);

  return getDiaryEntry(db, id);
}

/** Attempt to set status from idle/error → transcribing. Returns false on concurrent race. */
export function setTranscribing(db: Database, id: number): boolean {
  const info = db
    .prepare(
      `UPDATE diary_entries
       SET transcription_status = 'transcribing', transcription_error = NULL, updated_at = ?
       WHERE id = ? AND transcription_status != 'transcribing' AND deleted_at IS NULL`,
    )
    .run(Date.now(), id);
  return (info.changes as number) > 0;
}

export function setTranscriptionDone(
  db: Database,
  id: number,
  text: string,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE diary_entries
     SET transcription = ?, raw_transcription = ?,
         transcription_status = 'done', transcription_error = NULL,
         transcribed_at = ?, correction_status = 'idle', updated_at = ?
     WHERE id = ?`,
  ).run(text, text, now, now, id);
}

export function setCorrecting(db: Database, id: number): void {
  db.prepare(
    `UPDATE diary_entries
     SET correction_status = 'correcting', updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), id);
}

export function setCorrectionDone(
  db: Database,
  id: number,
  correctedText: string,
): void {
  db.prepare(
    `UPDATE diary_entries
     SET transcription = ?, correction_status = 'done', updated_at = ?
     WHERE id = ?`,
  ).run(correctedText, Date.now(), id);
}

export function setCorrectionError(db: Database, id: number): void {
  db.prepare(
    `UPDATE diary_entries
     SET correction_status = 'error', updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), id);
}

export function setTranscriptionError(
  db: Database,
  id: number,
  msg: string,
): void {
  db.prepare(
    `UPDATE diary_entries
     SET transcription_status = 'error', transcription_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(msg, Date.now(), id);
}

export function deleteDiaryEntry(
  db: Database,
  id: number,
  deletedBy: string | null = null,
): void {
  softDelete(db, "diary_entry", id, deletedBy);
}
