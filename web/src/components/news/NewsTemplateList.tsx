import type { NewsItem, NewsTopic, NewsReaction } from "../../api";
import { ExternalLink, ThumbsUp, ThumbsDown } from "../../lib/icons";

type Props = {
  items: NewsItem[];
  topics: NewsTopic[];
  reactions?: Record<number, NewsReaction>;
  onReact?: (itemId: number, reaction: NewsReaction | null) => void;
};

function formatDate(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function NewsTemplateList({ items, topics, reactions = {}, onReact }: Props) {
  const topicById = new Map(topics.map((t) => [t.id, t]));

  return (
    <ul className="news-list">
      {items.map((item) => {
        const topic = topicById.get(item.topicId);
        const reaction = reactions[item.id] ?? null;
        const dateLabel = formatDate(item.publishedAt ?? item.firstSeenAt);
        const handleThumb = (thumb: NewsReaction) => {
          if (!onReact) return;
          onReact(item.id, reaction === thumb ? null : thumb);
        };

        return (
          <li key={item.id} className="news-list__item">
            <div className="news-list__meta">
              {topic && <span className="news-list__topic">{topic.name}</span>}
              {item.source && <span className="news-list__source">{item.source}</span>}
              <span className="news-list__date">{dateLabel}</span>
            </div>
            <h3 className="news-list__title">
              {item.url ? (
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.title}
                  <ExternalLink size={12} />
                </a>
              ) : (
                item.title
              )}
            </h3>
            {item.summary && <p className="news-list__summary">{item.summary}</p>}
            {onReact && (
              <div className="news-card__reactions">
                <button
                  type="button"
                  className={`news-card__reaction-btn ${reaction === "up" ? "news-card__reaction-btn--active-up" : ""}`}
                  onClick={() => handleThumb("up")}
                  title="Interessant"
                  aria-pressed={reaction === "up"}
                >
                  <ThumbsUp size={13} />
                </button>
                <button
                  type="button"
                  className={`news-card__reaction-btn ${reaction === "down" ? "news-card__reaction-btn--active-down" : ""}`}
                  onClick={() => handleThumb("down")}
                  title="Niet interessant"
                  aria-pressed={reaction === "down"}
                >
                  <ThumbsDown size={13} />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
