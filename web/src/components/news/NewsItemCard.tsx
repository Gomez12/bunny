import type { NewsItem, NewsTopic } from "../../api";
import { ExternalLink } from "../../lib/icons";

type Props = {
  item: NewsItem;
  topic: NewsTopic | undefined;
  showTopicBadge?: boolean;
  compact?: boolean;
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
}: Props) {
  const dateLabel = formatDate(item.publishedAt ?? item.firstSeenAt);
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
      </div>
    </article>
  );
}
