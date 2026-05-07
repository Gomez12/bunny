# ADR 0041 — Diary subsystem (voice diary with speech-to-text)

**Status:** accepted  
**Date:** 2026-05-07

## Context

An experimental subsystem to test offline, GPU-free, CPU-only speech transcription for Dutch-language voice memos. The user speaks a diary entry in the browser, the audio is stored on the Bunny server, and whisper.cpp transcribes it locally. The primary research question is: does whisper.cpp on CPU produce usable Dutch transcriptions, and does the latency feel acceptable for a batched (record → upload → transcribe) workflow?

## Decision

### Audio path: browser converts WebM → WAV

`MediaRecorder` captures audio as WebM/Opus. Whisper.cpp natively processes WAV (PCM). Converting in the browser using `AudioContext.decodeAudioData` + `OfflineAudioContext` resampling to 16 kHz mono 16-bit avoids a server-side `ffmpeg` dependency, keeping the binary portable. The resulting WAV is ~1 MB/min — acceptable for a diary use case.

### Transcription: batched via whisper.cpp

Live/streaming transcription requires chunking with overlap, dramatically reduces accuracy (no sentence context), and complicates the server implementation. Batched processing (record the full memo, upload once, transcribe once) is simpler, more accurate, and sufficient for the use case. The `transcription_status` column (`idle | transcribing | done | error`) tracks progress; the HTTP `POST /api/diary/:id/transcribe` route streams SSE events back to the browser.

### Process spawning: Bun.spawn with concurrent stdout/stderr drain

Whisper.cpp logs heavily to stderr (model load info, per-segment timing, `whisper_print_timings`). Draining only stdout causes an OS pipe-buffer deadlock (~64 KB on macOS/Linux) that makes transcription appear to hang. Both streams are drained concurrently with `Promise.all` before reading the result, matching the `bash_exec.ts` pattern from workflows.

### Storage: workspace `diary/<id>/audio.wav`

Audio files live in the project workspace following the same filesystem layout as document images (`documents/<id>/images/…`). The existing `writeWorkspaceFile` / `safeWorkspacePath` helpers enforce path traversal protection.

### Configuration: `[diary]` block in `bunny.config.toml`

Four settings: `whisper_cpp_path`, `whisper_model_path`, `whisper_language` (default `nl`), `whisper_timeout_ms` (default 5 min). When `whisper_cpp_path` is empty the transcribe endpoint returns 503, so the rest of the diary feature (recording, storage, manual title editing) still works without whisper installed.

### Not included in v1

- Soft-delete / trash integration (registered via `registerTrashable`)
- Language selection per entry (dropdown)
- Re-transcribe button (after error or for comparison)
- No translation sidecar — diary entries are personal, not translated

## Consequences

- **Positive:** Fully offline, no GPU, no cloud services. Dutch quality depends on the whisper model size; `ggml-small.bin` is the recommended starting point.
- **Negative:** CPU transcription is slow: `small` model transcribes ~1 minute of audio in ~3 minutes on an unoptimised CPU server. Users must wait. A progress indicator is shown during the SSE stream.
- **Negative:** No live transcription — the user must finish recording before seeing any text.
- **Neutral:** whisper.cpp binary + model are not included; the operator must install them separately.
