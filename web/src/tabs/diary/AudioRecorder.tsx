import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, MicOff, Loader2, Square } from "../../lib/icons";
import { encodeWav } from "./wavEncoder";

export type RecordingState =
  | "idle"
  | "recording"
  | "processing"
  | "uploading"
  | "transcribing"
  | "done"
  | "error";

interface Props {
  entryId: number;
  onDone: (transcription: string) => void;
  onError: (msg: string) => void;
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const STATUS_LABEL: Record<string, string> = {
  processing: "Converting…",
  uploading: "Uploading…",
  transcribing: "Transcribing…",
};

export default function AudioRecorder({ entryId, onDone, onError }: Props) {
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopTimer(), [stopTimer]);

  // Check if getUserMedia is available (requires secure context or localhost)
  const mediaAvailable =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  async function startRecording() {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      setElapsed(0);

      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        stopTimer();
        stream.getTracks().forEach((t) => t.stop());
        const durationS = Math.floor(
          (Date.now() - startTimeRef.current) / 1000,
        );
        await processAndUpload(chunksRef.current, durationS);
      };

      mr.start(100);
      startTimeRef.current = Date.now();
      setState("recording");

      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 500);
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Could not access microphone";
      setErrorMsg(msg);
      setState("error");
      onError(msg);
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      setState("processing");
    }
  }

  async function processAndUpload(chunks: BlobPart[], durationS: number) {
    try {
      setState("processing");

      const rawBlob = new Blob(chunks, { type: "audio/webm" });
      const arrayBuffer = await rawBlob.arrayBuffer();
      const audioCtx = new AudioContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();
      const wavBlob = await encodeWav(decoded);

      setState("uploading");

      const formData = new FormData();
      formData.append(
        "file",
        new File([wavBlob], "audio.wav", { type: "audio/wav" }),
      );
      formData.append("durationS", String(durationS));

      const uploadRes = await fetch(`/api/diary/${entryId}/audio`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!uploadRes.ok) {
        const err = await uploadRes
          .json()
          .catch(() => ({ error: "upload failed" }));
        throw new Error((err as { error?: string }).error ?? "upload failed");
      }

      setState("transcribing");

      const transcribeRes = await fetch(`/api/diary/${entryId}/transcribe`, {
        method: "POST",
        credentials: "include",
      });
      if (!transcribeRes.ok) {
        const err = await transcribeRes
          .json()
          .catch(() => ({ error: "transcription failed" }));
        throw new Error(
          (err as { error?: string }).error ?? "transcription failed",
        );
      }

      const reader = transcribeRes.body?.getReader();
      if (!reader) throw new Error("no response body");

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
              error?: string;
            };
            if (ev.type === "diary_transcription_done") {
              setState("done");
              onDone(ev.transcription ?? "");
              return;
            }
            if (ev.type === "diary_transcription_error") {
              throw new Error(ev.error ?? "transcription failed");
            }
          } catch {
            // skip malformed event lines
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setErrorMsg(msg);
      setState("error");
      onError(msg);
    }
  }

  if (state === "done") return null;

  // Tauri / non-secure context: getUserMedia not available
  if (!mediaAvailable) {
    return (
      <div className="audio-recorder__unavailable">
        <div className="audio-recorder__unavailable-icon">
          <MicOff size={20} />
        </div>
        <p className="audio-recorder__unavailable-title">
          Microphone not available
        </p>
        <p className="audio-recorder__unavailable-desc">
          Audio recording requires a secure context (HTTPS or localhost). When
          using the desktop app over HTTP, open Bunny in a browser instead.
        </p>
      </div>
    );
  }

  return (
    <div className="audio-recorder">
      {state === "idle" && (
        <>
          <button
            className="audio-recorder__mic-btn"
            onClick={() => void startRecording()}
            title="Start recording"
          >
            <Mic size={28} />
          </button>
          <span className="audio-recorder__mic-label">
            Tap to start recording
          </span>
        </>
      )}

      {state === "recording" && (
        <div className="audio-recorder__recording">
          <div className="audio-recorder__pulse-wrap">
            <div className="audio-recorder__pulse-dot" />
          </div>
          <span className="audio-recorder__timer">
            {formatDuration(elapsed)}
          </span>
          <button
            className="audio-recorder__stop-btn"
            onClick={stopRecording}
            title="Stop recording"
          >
            <Square size={16} />
          </button>
        </div>
      )}

      {(state === "processing" ||
        state === "uploading" ||
        state === "transcribing") && (
        <div className="audio-recorder__busy">
          <Loader2 size={18} className="spin" />
          <span>{STATUS_LABEL[state]}</span>
        </div>
      )}

      {state === "error" && (
        <div className="audio-recorder__error">
          <p className="audio-recorder__error-msg">{errorMsg}</p>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setState("idle");
              setErrorMsg(null);
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
