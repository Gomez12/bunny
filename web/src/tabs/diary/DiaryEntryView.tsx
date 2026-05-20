import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowLeft, Loader2, RefreshCw, AudioLines } from "../../lib/icons";
import HistoryButton from "../../components/HistoryButton";
import AudioRecorder from "./AudioRecorder";

interface DiaryEntry {
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
  transcriptionStatus: string;
  transcriptionError: string | null;
  transcribedAt: number | null;
  correctionStatus: string;
  createdAt: number;
  updatedAt: number;
}

const LANGUAGES = [
  { code: "nl", label: "Nederlands" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "pl", label: "Polski" },
];

interface Props {
  entry: DiaryEntry;
  onBack: () => void;
  onUpdate: (entry: DiaryEntry) => void;
}

export default function DiaryEntryView({ entry, onBack, onUpdate }: Props) {
  const [title, setTitle] = useState(entry.title);
  const [language, setLanguage] = useState(entry.language);
  const [localEntry, setLocalEntry] = useState(entry);
  const [retranscribing, setRetranscribing] = useState(false);
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalEntry(entry);
    setTitle(entry.title);
    setLanguage(entry.language);
  }, [entry]);

  const patch = useCallback(
    async (p: { title?: string; language?: string }) => {
      const res = await fetch(`/api/diary/${localEntry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
        credentials: "include",
      });
      if (res.ok) {
        const { entry: updated } = (await res.json()) as { entry: DiaryEntry };
        setLocalEntry(updated);
        onUpdate(updated);
      }
    },
    [localEntry.id, onUpdate],
  );

  function handleTitleChange(v: string) {
    setTitle(v);
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = setTimeout(() => void patch({ title: v }), 600);
  }

  function handleLanguageChange(v: string) {
    setLanguage(v);
    void patch({ language: v });
  }

  function handleRecordingDone(result: {
    transcription: string;
    rawTranscription?: string;
    generatedTitle?: string;
  }) {
    const updated: DiaryEntry = {
      ...localEntry,
      transcription: result.transcription,
      rawTranscription: result.rawTranscription ?? result.transcription,
      correctionStatus: "done",
      transcriptionStatus: "done",
      title: result.generatedTitle ?? localEntry.title,
    };
    if (result.generatedTitle) setTitle(result.generatedTitle);
    setLocalEntry(updated);
    onUpdate(updated);
  }

  async function handleRetranscribe() {
    if (retranscribing) return;
    setRetranscribing(true);
    try {
      const res = await fetch(`/api/diary/${localEntry.id}/transcribe`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" }));
        throw new Error((err as { error?: string }).error ?? "failed");
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6)) as {
              type: string;
              transcription?: string;
              rawTranscription?: string;
              title?: string;
              error?: string;
            };
            if (ev.type === "diary_transcription_done") {
              setLocalEntry((prev) => ({
                ...prev,
                rawTranscription: ev.rawTranscription ?? "",
                transcription: ev.rawTranscription ?? "",
                transcriptionStatus: "done",
                transcriptionError: null,
                correctionStatus: "idle",
              }));
            }
            if (ev.type === "diary_correction_started") {
              setLocalEntry((prev) => ({
                ...prev,
                correctionStatus: "correcting",
              }));
            }
            if (ev.type === "diary_correction_done") {
              setLocalEntry((prev) => ({
                ...prev,
                transcription: ev.transcription ?? prev.transcription,
                correctionStatus: "done",
              }));
            }
            if (ev.type === "diary_correction_error") {
              setLocalEntry((prev) => ({
                ...prev,
                correctionStatus: "error",
              }));
            }
            if (ev.type === "diary_title_generated" && ev.title) {
              setTitle(ev.title);
              setLocalEntry((prev) => ({ ...prev, title: ev.title! }));
              onUpdate({ ...localEntry, title: ev.title });
            }
            if (ev.type === "diary_transcription_error") {
              setLocalEntry((prev) => ({
                ...prev,
                transcriptionStatus: "error",
                transcriptionError: ev.error ?? "unknown error",
              }));
            }
          } catch {
            // skip
          }
        }
      }
      // After stream ends, sync the parent with the final state.
      setLocalEntry((prev) => {
        onUpdate(prev);
        return prev;
      });
    } catch {
      // error shown via SSE
    } finally {
      setRetranscribing(false);
    }
  }

  const createdDate = new Date(localEntry.createdAt).toLocaleDateString(
    "nl-NL",
    { year: "numeric", month: "long", day: "numeric" },
  );

  const showRetranscribe =
    localEntry.audioPath &&
    (localEntry.transcriptionStatus === "done" ||
      localEntry.transcriptionStatus === "error" ||
      localEntry.transcriptionStatus === "idle");

  return (
    <div className="diary-entry">
      {/* Header */}
      <div className="diary-entry__header">
        <button className="btn btn--ghost btn--icon" onClick={onBack} title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="diary-entry__meta">
          <span className="diary-entry__date">{createdDate}</span>
          <select
            className="diary-entry__lang-select"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            title="Transcription language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <HistoryButton
            kind="diary_entry"
            entityId={entry.id}
            entityName={entry.title || createdDate}
          />
        </div>
      </div>

      {/* Title */}
      <input
        className="diary-entry__title-input"
        type="text"
        placeholder="Add a title…"
        value={title}
        onChange={(e) => handleTitleChange(e.target.value)}
      />

      <div className="diary-entry__body">
        {/* Record section — shown only when no audio */}
        {!localEntry.audioPath && (
          <div className="diary-entry__record">
            <p className="diary-entry__record-hint">
              Record a voice memo. When you stop, the audio is uploaded and
              transcribed automatically with whisper.
            </p>
            <AudioRecorder
              entryId={localEntry.id}
              onDone={handleRecordingDone}
              onError={() => {}}
            />
          </div>
        )}

        {/* Audio player — shown once audio is uploaded */}
        {localEntry.audioPath && (
          <div className="diary-entry__audio">
            <div className="diary-entry__audio-label">
              <AudioLines size={14} />
              <span>Recording</span>
              {localEntry.audioDurationS != null && (
                <span style={{ color: "var(--text-faint)" }}>
                  {Math.round(localEntry.audioDurationS)}s
                </span>
              )}
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio
              controls
              src={`/api/diary/${localEntry.id}/audio`}
              className="diary-entry__audio-player"
            />
          </div>
        )}

        {/* Transcription — shown once audio is uploaded */}
        {localEntry.audioPath && (
          <div className="diary-entry__transcription">
            <div className="diary-entry__transcription-header">
              <span className="diary-entry__transcription-label">
                Transcription
              </span>
              {showRetranscribe && (
                <button
                  className="btn btn--ghost btn--sm btn--icon"
                  onClick={() => void handleRetranscribe()}
                  disabled={retranscribing}
                  title="Transcribe again"
                >
                  {retranscribing ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                </button>
              )}
            </div>

            {localEntry.transcriptionStatus === "idle" && (
              <p className="diary-entry__transcription-empty">
                Not yet transcribed.
              </p>
            )}

            {(localEntry.transcriptionStatus === "transcribing" ||
              retranscribing) && (
              <div className="diary-entry__transcription-busy">
                <Loader2 size={16} className="spin" />
                <span>Transcribing…</span>
              </div>
            )}

            {localEntry.transcriptionStatus === "done" && (
              <>
                {localEntry.correctionStatus === "correcting" && (
                  <div className="diary-entry__transcription-busy">
                    <Loader2 size={14} className="spin" />
                    <span>Correcting…</span>
                  </div>
                )}

                {localEntry.correctionStatus !== "correcting" &&
                  localEntry.transcription && (
                    <div className="diary-entry__transcription-text">
                      {localEntry.transcription}
                    </div>
                  )}

                {localEntry.rawTranscription &&
                  localEntry.rawTranscription !== localEntry.transcription && (
                    <details className="diary-entry__raw-transcription">
                      <summary className="diary-entry__raw-summary">
                        Raw transcription
                      </summary>
                      <div className="diary-entry__transcription-text diary-entry__transcription-text--raw">
                        {localEntry.rawTranscription}
                      </div>
                    </details>
                  )}
              </>
            )}

            {localEntry.transcriptionStatus === "error" && (
              <div className="diary-entry__transcription-error">
                {localEntry.transcriptionError ?? "Transcription failed."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
