import { useEffect, useState } from "react";
import { fetchCardRuns, streamCardRun, type CardRun, type ServerEvent } from "../api";

interface Props {
  cardId: number;
  /** When the parent wants to deep-link to the chat view, give it the session id. */
  onOpenSession: (sessionId: string) => void;
  /** Bumped by the parent after a Run is triggered to refresh the list. */
  refreshKey: number;
  /** When set, the component opens an SSE stream for this active run. */
  liveRunId?: number;
}

export default function CardRunLog({ cardId, onOpenSession, refreshKey, liveRunId }: Props) {
  const [runs, setRuns] = useState<CardRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [liveContent, setLiveContent] = useState("");
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    void fetchCardRuns(cardId)
      .then(setRuns)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [cardId, refreshKey]);

  useEffect(() => {
    if (!liveRunId) return;
    setStreaming(true);
    setLiveContent("");
    const { done, abort } = streamCardRun(cardId, liveRunId, (ev: ServerEvent) => {
      if (ev.type === "content") setLiveContent((s) => s + ev.text);
      if (ev.type === "card_run_finished") {
        setStreaming(false);
        // Refresh persisted runs once the stream wraps up.
        void fetchCardRuns(cardId).then(setRuns).catch(() => undefined);
      }
    });
    void done.catch((e) => {
      // 409 means the run already ended before we subscribed; not an error.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("already completed")) setError(msg);
      setStreaming(false);
    });
    return () => abort();
  }, [cardId, liveRunId]);

  if (error) return <div className="run-log__error">{error}</div>;

  return (
    <div className="run-log">
      <h3 className="run-log__title">Runs</h3>
      {streaming && (
        <div className="run-log__live">
          <span className="run-log__chip run-log__chip--running">streaming…</span>
          <pre className="run-log__answer">{liveContent || "…"}</pre>
        </div>
      )}
      {runs.length === 0 && !streaming && (
        <div className="run-log__empty">No runs yet.</div>
      )}
      <ul className="run-log__list">
        {runs.map((r) => (
          <li key={r.id} className="run-log__row">
            <div className="run-log__row-head">
              <span className={`run-log__chip run-log__chip--${r.status}`}>{r.status}</span>
              <span className="run-log__agent">@{r.agent}</span>
              <span className="run-log__time">{new Date(r.startedAt).toLocaleString()}</span>
              <button
                type="button"
                className="run-log__open"
                onClick={() => onOpenSession(r.sessionId)}
                title="Open run in Chat tab"
              >
                Open in Chat
              </button>
            </div>
            {r.finalAnswer && (
              <pre className="run-log__answer">{r.finalAnswer.slice(0, 1000)}</pre>
            )}
            {r.error && <pre className="run-log__answer run-log__answer--error">{r.error}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}
