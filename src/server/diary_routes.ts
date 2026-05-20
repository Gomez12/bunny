/**
 * HTTP routes for the Diary subsystem.
 *
 * Experimental speech-to-text feature: records audio in the browser,
 * uploads WAV to the server, and transcribes with whisper.cpp on CPU.
 *
 *   GET    /api/projects/:p/diary
 *   POST   /api/projects/:p/diary
 *   GET    /api/diary/:id
 *   PATCH  /api/diary/:id
 *   DELETE /api/diary/:id
 *   POST   /api/diary/:id/audio      (multipart WAV upload)
 *   GET    /api/diary/:id/audio      (stream WAV)
 *   POST   /api/diary/:id/transcribe (SSE — kicks off whisper.cpp)
 */

import type { Database } from "bun:sqlite";
import type { BunnyConfig } from "../config.ts";
import type { BunnyQueue } from "../queue/bunqueue.ts";
import type { User } from "../auth/users.ts";
import { json } from "./http.ts";
import { requireProjectAccess } from "./route_helpers.ts";
import { errorDetails, errorMessage } from "../util/error.ts";
import {
  createDiaryEntry,
  deleteDiaryEntry,
  getDiaryEntry,
  listDiaryEntries,
  setCorrecting,
  setCorrectionDone,
  setCorrectionError,
  setTranscribing,
  setTranscriptionDone,
  setTranscriptionError,
  updateDiaryEntry,
  type DiaryEntry,
} from "../memory/diary.ts";
import {
  writeWorkspaceFile,
  safeWorkspacePath,
} from "../memory/workspace_fs.ts";
import {
  controllerSink,
  finishSse,
  type SseSink,
} from "../agent/render_sse.ts";
import { recordVersion } from "../memory/versioning.ts";
import { chatSync } from "../llm/adapter.ts";
import { resolvePrompt, interpolate } from "../prompts/resolve.ts";

export interface DiaryRouteCtx {
  db: Database;
  queue: BunnyQueue;
  cfg: BunnyConfig;
}

const SSE_ENCODER = new TextEncoder();
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB

function sendSse(sink: SseSink, payload: object): void {
  sink.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function canAccessEntry(user: User, entry: DiaryEntry): boolean {
  if (user.role === "admin") return true;
  return entry.userId === user.id;
}

function entryToDto(entry: DiaryEntry) {
  return {
    id: entry.id,
    project: entry.project,
    userId: entry.userId,
    title: entry.title,
    audioPath: entry.audioPath,
    audioDurationS: entry.audioDurationS,
    audioSizeB: entry.audioSizeB,
    language: entry.language,
    transcription: entry.transcription,
    rawTranscription: entry.rawTranscription,
    transcriptionStatus: entry.transcriptionStatus,
    transcriptionError: entry.transcriptionError,
    transcribedAt: entry.transcribedAt,
    correctionStatus: entry.correctionStatus,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export async function handleDiaryRoute(
  req: Request,
  url: URL,
  ctx: DiaryRouteCtx,
  user: User,
): Promise<Response | null> {
  const { pathname } = url;

  // GET /api/projects/:p/diary
  // POST /api/projects/:p/diary
  const listMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diary$/);
  if (listMatch) {
    const rawProject = decodeURIComponent(listMatch[1]!);
    const access = requireProjectAccess(ctx.db, user, rawProject, "view");
    if (!access.ok) return access.response;
    const { project } = access;

    if (req.method === "GET") {
      const entries = listDiaryEntries(ctx.db, project, user.id);
      return json({ entries: entries.map(entryToDto) });
    }

    if (req.method === "POST") {
      let body: { title?: string; language?: string } = {};
      try {
        body = (await req.json()) as { title?: string; language?: string };
      } catch {
        // empty body is fine — use defaults
      }
      const entry = createDiaryEntry(ctx.db, {
        project,
        userId: user.id,
        title: body.title?.trim() ?? "",
        language: body.language?.trim() || ctx.cfg.diary.whisperLanguage,
      });
      recordVersion(ctx.db, "diary_entry", entry.id, "save", user.id);
      void ctx.queue.log({
        topic: "diary",
        kind: "create",
        userId: user.id,
        data: {
          id: entry.id,
          project,
          title: entry.title || null,
          language: entry.language,
        },
      });
      return json({ entry: entryToDto(entry) }, 201);
    }

    return null;
  }

  // Routes on a specific entry id
  const idMatch = pathname.match(/^\/api\/diary\/(\d+)(\/.*)?$/);
  if (!idMatch) return null;

  const id = Number(idMatch[1]);
  const sub = idMatch[2] ?? "";

  // GET /api/diary/:id
  if (sub === "" && req.method === "GET") {
    const entry = getDiaryEntry(ctx.db, id);
    if (!entry) return json({ error: "not found" }, 404);
    if (!canAccessEntry(user, entry)) return json({ error: "forbidden" }, 403);
    return json({ entry: entryToDto(entry) });
  }

  // PATCH /api/diary/:id
  if (sub === "" && req.method === "PATCH") {
    const entry = getDiaryEntry(ctx.db, id);
    if (!entry) return json({ error: "not found" }, 404);
    if (!canAccessEntry(user, entry)) return json({ error: "forbidden" }, 403);

    let body: { title?: string; language?: string };
    try {
      body = (await req.json()) as { title?: string; language?: string };
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const updated = updateDiaryEntry(ctx.db, id, {
      title: body.title,
      language: body.language,
    });
    recordVersion(ctx.db, "diary_entry", id, "save", user.id);
    void ctx.queue.log({
      topic: "diary",
      kind: "update",
      userId: user.id,
      data: {
        id,
        project: entry.project,
        changes: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.language !== undefined ? { language: body.language } : {}),
        },
        transcriptionStatus: entry.transcriptionStatus,
      },
    });
    return json({ entry: entryToDto(updated!) });
  }

  // DELETE /api/diary/:id
  if (sub === "" && req.method === "DELETE") {
    const entry = getDiaryEntry(ctx.db, id);
    if (!entry) return json({ error: "not found" }, 404);
    if (!canAccessEntry(user, entry)) return json({ error: "forbidden" }, 403);
    deleteDiaryEntry(ctx.db, id, user.id);
    void ctx.queue.log({
      topic: "diary",
      kind: "delete",
      userId: user.id,
      data: {
        id,
        project: entry.project,
        title: entry.title || null,
        transcriptionStatus: entry.transcriptionStatus,
        hadAudio: !!entry.audioPath,
        hadTranscription: !!entry.transcription,
      },
    });
    return json({ ok: true });
  }

  // POST /api/diary/:id/audio — upload WAV
  if (sub === "/audio" && req.method === "POST") {
    const entry = getDiaryEntry(ctx.db, id);
    if (!entry) return json({ error: "not found" }, 404);
    if (!canAccessEntry(user, entry)) return json({ error: "forbidden" }, 403);

    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return json({ error: "expected multipart/form-data" }, 400);
    }

    let formData: globalThis.FormData;
    try {
      formData = (await req.formData()) as unknown as globalThis.FormData;
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }

    const file = formData.get("file") as File | null;
    if (!file || !(file instanceof File)) {
      return json({ error: "missing 'file' field" }, 400);
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return json({ error: "audio file too large (50 MB max)" }, 413);
    }

    const relPath = `diary/${id}/audio.wav`;
    const buffer = new Uint8Array(await file.arrayBuffer());
    writeWorkspaceFile(entry.project, relPath, buffer);

    const durationS = formData.get("durationS") as string | null;
    const parsedDuration = durationS ? Number(durationS) : undefined;

    const updated = updateDiaryEntry(ctx.db, id, {
      audioPath: relPath,
      audioSizeB: buffer.byteLength,
      audioDurationS: Number.isFinite(parsedDuration)
        ? parsedDuration
        : undefined,
    });

    void ctx.queue.log({
      topic: "diary",
      kind: "audio.upload",
      userId: user.id,
      data: {
        id,
        project: entry.project,
        sizeB: buffer.byteLength,
        durationS: Number.isFinite(parsedDuration) ? parsedDuration : null,
        language: entry.language,
        relPath,
      },
    });

    return json({ entry: entryToDto(updated!) }, 201);
  }

  // GET /api/diary/:id/audio — stream WAV
  if (sub === "/audio" && req.method === "GET") {
    const entry = getDiaryEntry(ctx.db, id);
    if (!entry) return json({ error: "not found" }, 404);
    if (!canAccessEntry(user, entry)) return json({ error: "forbidden" }, 403);
    if (!entry.audioPath) return json({ error: "no audio recorded yet" }, 404);

    let abs: string;
    try {
      ({ abs } = safeWorkspacePath(entry.project, entry.audioPath));
    } catch (e) {
      return json({ error: errorMessage(e) }, 400);
    }

    const file = Bun.file(abs);
    const exists = await file.exists();
    if (!exists) return json({ error: "audio file missing" }, 404);

    return new Response(file, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Disposition": `inline; filename="diary-${id}.wav"`,
      },
    });
  }

  // POST /api/diary/:id/transcribe — SSE, launches whisper.cpp
  if (sub === "/transcribe" && req.method === "POST") {
    const entry = getDiaryEntry(ctx.db, id);
    if (!entry) return json({ error: "not found" }, 404);
    if (!canAccessEntry(user, entry)) return json({ error: "forbidden" }, 403);
    if (!entry.audioPath) {
      return json({ error: "no audio uploaded yet" }, 400);
    }

    const {
      whisperCppPath,
      whisperModelPath,
      whisperLanguage,
      whisperTimeoutMs,
    } = ctx.cfg.diary;

    if (!whisperCppPath) {
      return json(
        {
          error:
            "whisper.cpp is not configured — set [diary] whisper_cpp_path in bunny.config.toml",
        },
        503,
      );
    }
    if (!whisperModelPath) {
      return json(
        {
          error:
            "whisper model is not configured — set [diary] whisper_model_path in bunny.config.toml",
        },
        503,
      );
    }

    const claimed = setTranscribing(ctx.db, id);
    if (!claimed) {
      return json({ error: "transcription already in progress" }, 409);
    }

    void ctx.queue.log({
      topic: "diary",
      kind: "transcribe.start",
      userId: user.id,
      data: {
        id,
        project: entry.project,
        language: entry.language || whisperLanguage,
        audioPath: entry.audioPath,
        audioSizeB: entry.audioSizeB,
        audioDurationS: entry.audioDurationS,
        whisperCppPath,
        whisperModelPath,
      },
    });

    let wavAbs: string;
    try {
      ({ abs: wavAbs } = safeWorkspacePath(entry.project, entry.audioPath));
    } catch (e) {
      setTranscriptionError(ctx.db, id, errorMessage(e));
      return json({ error: errorMessage(e) }, 400);
    }

    const language = entry.language || whisperLanguage;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sink = controllerSink(controller);
        sendSse(sink, { type: "diary_transcription_started", entryId: id });

        const abortCtrl = new AbortController();
        let timedOut = false;
        const startMs = Date.now();
        const timer = setTimeout(() => {
          timedOut = true;
          abortCtrl.abort();
        }, whisperTimeoutMs);

        let proc: ReturnType<typeof Bun.spawn> | undefined;
        try {
          proc = Bun.spawn(
            [
              whisperCppPath,
              "-m",
              whisperModelPath,
              "-l",
              language,
              "-f",
              wavAbs,
              "--no-timestamps",
            ],
            {
              stdout: "pipe",
              stderr: "pipe",
              signal: abortCtrl.signal,
            },
          );

          // Drain stdout and stderr concurrently to prevent OS pipe-buffer
          // deadlock (whisper.cpp logs heavily to stderr; ~64 KB fill blocks).
          const collectStream = async (
            stream: AsyncIterable<Uint8Array>,
          ): Promise<Uint8Array[]> => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream) chunks.push(chunk);
            return chunks;
          };

          const [stdoutChunks, stderrChunks] = await Promise.all([
            collectStream(proc.stdout as AsyncIterable<Uint8Array>),
            collectStream(proc.stderr as AsyncIterable<Uint8Array>),
          ]);

          await proc.exited;
          clearTimeout(timer);

          if (timedOut) {
            throw new Error(
              `whisper.cpp timed out after ${Math.round(whisperTimeoutMs / 1000)}s`,
            );
          }

          const exitCode = proc.exitCode;
          const stderr = new TextDecoder()
            .decode(Buffer.concat(stderrChunks))
            .trim();
          const elapsedMs = Date.now() - startMs;

          if (exitCode !== 0) {
            throw new Error(
              `whisper.cpp exited with code ${exitCode}${stderr ? `: ${stderr}` : ""}`,
            );
          }

          const raw = new TextDecoder()
            .decode(Buffer.concat(stdoutChunks))
            .trim();

          setTranscriptionDone(ctx.db, id, raw);
          sendSse(sink, {
            type: "diary_transcription_done",
            entryId: id,
            rawTranscription: raw,
          });

          void ctx.queue.log({
            topic: "diary",
            kind: "transcribe.done",
            userId: user.id,
            data: {
              id,
              project: entry.project,
              language,
              chars: raw.length,
              elapsedMs,
              exitCode,
              transcriptionPreview: raw.length > 0 ? raw.slice(0, 500) : null,
              stdoutBytes: Buffer.concat(stdoutChunks).byteLength,
              stderrBytes: stderr.length,
              stderrTail: stderr.length > 0 ? stderr.slice(-500) : null,
            },
          });

          // ── LLM correction phase ──────────────────────────────────────────
          let corrected = raw;
          if (raw.length > 0) {
            setCorrecting(ctx.db, id);
            sendSse(sink, { type: "diary_correction_started", entryId: id });
            try {
              const correctionPrompt = interpolate(
                resolvePrompt("diary.correct_transcription", {
                  project: entry.project,
                }),
                { rawTranscription: raw },
              );
              const correctionRes = await chatSync(ctx.cfg.llm, {
                model: ctx.cfg.llm.model,
                messages: [{ role: "user", content: correctionPrompt }],
              });
              corrected = (correctionRes.message.content ?? raw).trim();
              if (corrected.length === 0) corrected = raw;
              setCorrectionDone(ctx.db, id, corrected);
              sendSse(sink, {
                type: "diary_correction_done",
                entryId: id,
                transcription: corrected,
              });
              void ctx.queue.log({
                topic: "diary",
                kind: "correction.done",
                userId: user.id,
                data: { id, project: entry.project, chars: corrected.length },
              });
            } catch (corrErr) {
              setCorrectionError(ctx.db, id);
              sendSse(sink, {
                type: "diary_correction_error",
                entryId: id,
                error: errorMessage(corrErr),
              });
              void ctx.queue.log({
                topic: "diary",
                kind: "correction.error",
                userId: user.id,
                data: {
                  id,
                  project: entry.project,
                  error: errorDetails(corrErr),
                },
              });
            }
          }

          // ── Auto-title generation (only when title is empty) ─────────────
          if (!entry.title.trim() && corrected.length > 0) {
            try {
              const titlePrompt = interpolate(
                resolvePrompt("diary.generate_title", {
                  project: entry.project,
                }),
                { transcription: corrected.slice(0, 2000) },
              );
              const titleRes = await chatSync(ctx.cfg.llm, {
                model: ctx.cfg.llm.model,
                messages: [{ role: "user", content: titlePrompt }],
              });
              const generatedTitle = (titleRes.message.content ?? "").trim();
              if (generatedTitle) {
                updateDiaryEntry(ctx.db, id, { title: generatedTitle });
                sendSse(sink, {
                  type: "diary_title_generated",
                  entryId: id,
                  title: generatedTitle,
                });
                void ctx.queue.log({
                  topic: "diary",
                  kind: "title.generate.done",
                  userId: user.id,
                  data: { id, project: entry.project, title: generatedTitle },
                });
              }
            } catch {
              // Non-fatal — title stays empty, user can fill it in manually.
            }
          }
        } catch (e) {
          const elapsedMs = Date.now() - startMs;
          clearTimeout(timer);
          const msg = timedOut
            ? `whisper.cpp timed out after ${Math.round(whisperTimeoutMs / 1000)}s`
            : errorMessage(e);
          setTranscriptionError(ctx.db, id, msg);
          sendSse(sink, {
            type: "diary_transcription_error",
            entryId: id,
            error: msg,
          });
          void ctx.queue.log({
            topic: "diary",
            kind: "transcribe.error",
            userId: user.id,
            data: {
              id,
              project: entry.project,
              language,
              timedOut,
              elapsedMs,
              exitCode: proc?.exitCode ?? null,
              error: msg,
              audioSizeB: entry.audioSizeB,
              audioDurationS: entry.audioDurationS,
            },
          });
        } finally {
          finishSse(sink);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Entry-Id": String(id),
      },
    });
  }

  return null;
}
