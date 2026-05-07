import type { NewsItem, NewsTopic, NewsReaction } from "../../api";
import { ExternalLink, ThumbsUp, ThumbsDown } from "../../lib/icons";

type Props = {
  item: NewsItem;
  topic: NewsTopic | undefined;
  showTopicBadge?: boolean;
  compact?: boolean;
  reaction?: NewsReaction | null;
  onReact?: (reaction: NewsReaction | null) => void;
};

function formatDate(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function NewsItemCard({
  item,
  topic,
  showTopicBadge = false,
  compact = false,
  reaction = null,
  onReact,
}: Props) {
  const dateLabel = formatDate(item.publishedAt ?? item.firstSeenAt);

  const handleThumb = (thumb: NewsReaction) => {
    if (!onReact) return;
    // Clicking the same reaction again removes it (toggle off)
    onReact(reaction === thumb ? null : thumb);
  };

  return (
    <article className={`news-card ${compact ? "news-card--compact" : ""}`}>
      {item.imageUrl && !compact && (
        <div className="news-card__media">
          <img src={item.imageUrl} alt="" loading="lazy" />
        </div>
      )}
      <div className="news-card__body">
        <div className="news-card__meta">
          {showTopicBadge && topic && (
            <span className="news-card__badge">{topic.name}</span>
          )}
          {item.source && (
            <span className="news-card__source">{item.source}</span>
          )}
          {dateLabel && <span className="news-card__date">{dateLabel}</span>}
        </div>
        <h3 className="news-card__title">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title}
              <ExternalLink size={14} />
            </a>
          ) : (
            item.title
          )}
        </h3>
        {item.summary && <p className="news-card__summary">{item.summary}</p>}
        {onReact && (
          <div className="news-card__reactions">
            <button
              type="button"
              className={`news-card__reaction-btn ${reaction === "up" ? "news-card__reaction-btn--active-up" : ""}`}
              onClick={() => handleThumb("up")}
              title="Interessant"
              aria-pressed={reaction === "up"}
            >
              <ThumbsUp size={14} />
            </button>
            <button
              type="button"
              className={`news-card__reaction-btn ${reaction === "down" ? "news-card__reaction-btn--active-down" : ""}`}
              onClick={() => handleThumb("down")}
              title="Niet interessant"
              aria-pressed={reaction === "down"}
            >
              <ThumbsDown size={14} />
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
