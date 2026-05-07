# Diary

Per-project, per-user voice diary with offline CPU speech-to-text via whisper.cpp.

## Purpose

Experimental subsystem — the primary goal is to evaluate whether whisper.cpp on CPU produces acceptable Dutch transcriptions without GPU or cloud services. Each diary entry stores a WAV recording and its transcription side-by-side.

## Architecture

```
Browser                     Server                       Disk
───────                     ──────                       ────
MediaRecorder (WebM)
  → AudioContext decode
  → OfflineAudioContext
    resample 16kHz mono
  → WAV Blob
  → POST /diary/:id/audio   writeWorkspaceFile()  →  diary/<id>/audio.wav
  → POST /diary/:id/transcribe (SSE)
                            Bun.spawn(whisper.cpp)
                            drain stdout + stderr concurrently
                            setTranscriptionDone()
  ← diary_transcription_done SSE event
```

## Database

Table: `diary_entries`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | autoincrement |
| `project` | TEXT | project scope |
| `user_id` | TEXT FK → users | ON DELETE CASCADE — deleting a user removes entries |
| `created_by` | TEXT FK → users | ON DELETE SET NULL — for trash display |
| `title` | TEXT | user-editable, default empty |
| `audio_path` | TEXT | relative workspace path (`diary/<id>/audio.wav`), NULL until uploaded |
| `audio_duration_s` | INTEGER | seconds, estimated from recording timer |
| `audio_size_b` | INTEGER | WAV file size |
| `language` | TEXT | BCP-47 short code, default `nl` |
| `transcription` | TEXT | NULL until done |
| `transcription_status` | TEXT | `idle \| transcribing \| done \| error` |
| `transcription_error` | TEXT | populated when status = error |
| `transcribed_at` | INTEGER | Unix ms |
| `created_at` | INTEGER | Unix ms |
| `updated_at` | INTEGER | Unix ms |
| `deleted_at` | INTEGER | non-null = soft-deleted |
| `deleted_by` | TEXT | user who deleted it |

## Config

```toml
[diary]
whisper_cpp_path = "/usr/local/bin/whisper-cpp"  # required for transcription
whisper_model_path = "/models/ggml-small.bin"    # required for transcription
whisper_language = "nl"                           # default language
whisper_timeout_ms = 300000                       # 5 min default
```

Environment overrides: `BUNNY_DIARY_WHISPER_CPP_PATH`, `BUNNY_DIARY_WHISPER_MODEL_PATH`, `BUNNY_DIARY_WHISPER_LANGUAGE`.

When `whisper_cpp_path` is empty, `POST /api/diary/:id/transcribe` returns 503. Recording and storage still work.

## HTTP Routes

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/projects/:p/diary` | list own entries |
| POST | `/api/projects/:p/diary` | create entry |
| GET | `/api/diary/:id` | get entry |
| PATCH | `/api/diary/:id` | update title/language |
| DELETE | `/api/diary/:id` | soft delete |
| POST | `/api/diary/:id/audio` | upload WAV (multipart, max 50 MB) |
| GET | `/api/diary/:id/audio` | stream WAV |
| POST | `/api/diary/:id/transcribe` | start transcription (SSE) |

## Permissions

All operations require authentication. Users can only access their own entries. Admins can access any entry.

## Status machine

```
idle  →  transcribing  →  done
                      ↘  error  →  transcribing (re-transcribe)
```

`setTranscribing` uses a conditional UPDATE that only succeeds if `transcription_status != 'transcribing'` — prevents duplicate concurrent runs.

## Audio format

Browser records WebM/Opus via `MediaRecorder`. Client-side conversion:
1. `AudioContext.decodeAudioData(webmBlob.arrayBuffer())`
2. `OfflineAudioContext` resamples to 16 kHz mono
3. Float32 PCM → Int16 → WAV container (44-byte header + raw PCM)

Result: ~1 MB per minute of audio, compatible with whisper.cpp.

## Recommended whisper.cpp models for Dutch

| Model | Size | CPU speed | Dutch quality |
|-------|------|-----------|---------------|
| `ggml-tiny.bin` | 75 MB | ~30s/min | poor |
| `ggml-base.bin` | 145 MB | ~60s/min | adequate |
| `ggml-small.bin` | 488 MB | ~3 min/min | **good** ← recommended |
| `ggml-medium.bin` | 1.5 GB | slow | excellent |

## Entry points

- `src/memory/diary.ts` — CRUD + status machine
- `src/server/diary_routes.ts` — HTTP routes + SSE transcription handler
- `web/src/tabs/DiaryTab.tsx` — main tab
- `web/src/tabs/diary/DiaryEntryView.tsx` — single entry view
- `web/src/tabs/diary/AudioRecorder.tsx` — mic button + WAV conversion
- `web/src/tabs/diary/wavEncoder.ts` — WAV encoder helper

## See also

[ADR 0041](../../adr/0041-diary-subsystem.md)
