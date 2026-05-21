import { useTranslation } from "react-i18next";
import type { TurnStats } from "../api";

interface Props {
  stats: TurnStats | null;
}

export default function StatsFooter({ stats }: Props) {
  const { t } = useTranslation();
  if (!stats) return null;
  const secs = stats.durationMs / 1000;
  const tokPerSec =
    stats.completionTokens && stats.durationMs > 0
      ? (stats.completionTokens / stats.durationMs) * 1000
      : null;
  return (
    <div className="stats">
      <span className="stats__icon">⚡</span>
      <span>{t("chat.stats.seconds", { value: secs.toFixed(2) })}</span>
      {stats.completionTokens != null && stats.completionTokens > 0 && (
        <>
          <span className="stats__sep">·</span>
          <span>{t("chat.stats.tokens", { count: stats.completionTokens })}</span>
        </>
      )}
      {tokPerSec != null && (
        <>
          <span className="stats__sep">·</span>
          <span>{t("chat.stats.tokensPerSec", { value: tokPerSec.toFixed(1) })}</span>
        </>
      )}
      {stats.promptTokens != null && stats.promptTokens > 0 && (
        <>
          <span className="stats__sep">·</span>
          <span title={t("chat.stats.promptTokensTitle")}>↑{stats.promptTokens}</span>
        </>
      )}
    </div>
  );
}
