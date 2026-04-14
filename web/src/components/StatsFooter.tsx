import type { TurnStats } from "../api";

interface Props {
  stats: TurnStats | null;
}

export default function StatsFooter({ stats }: Props) {
  if (!stats) return null;
  const secs = stats.durationMs / 1000;
  const tokPerSec =
    stats.completionTokens && stats.durationMs > 0
      ? (stats.completionTokens / stats.durationMs) * 1000
      : null;
  return (
    <div className="stats">
      <span className="stats__icon">⚡</span>
      <span>{secs.toFixed(2)}s</span>
      {stats.completionTokens != null && stats.completionTokens > 0 && (
        <>
          <span className="stats__sep">·</span>
          <span>{stats.completionTokens} tok</span>
        </>
      )}
      {tokPerSec != null && (
        <>
          <span className="stats__sep">·</span>
          <span>{tokPerSec.toFixed(1)} tok/s</span>
        </>
      )}
      {stats.promptTokens != null && stats.promptTokens > 0 && (
        <>
          <span className="stats__sep">·</span>
          <span title="prompt tokens">↑{stats.promptTokens}</span>
        </>
      )}
    </div>
  );
}
