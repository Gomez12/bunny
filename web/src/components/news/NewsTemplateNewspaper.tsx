import { useMemo } from "react";
import type { NewsItem, NewsTopic, NewsReaction } from "../../api";
import NewsItemCard from "./NewsItemCard";

type Props = {
  items: NewsItem[];
  topics: NewsTopic[];
  reactions?: Record<number, NewsReaction>;
  onReact?: (itemId: number, reaction: NewsReaction | null) => void;
};

function itemTs(item: NewsItem): number {
  return item.publishedAt ?? item.firstSeenAt;
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatSectionDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function NewsTemplateNewspaper({ items, topics, reactions = {}, onReact }: Props) {
  const topicById = useMemo(
    () => new Map(topics.map((t) => [t.id, t])),
    [topics],
  );

  const { grouped, sortedDates } = useMemo(() => {
    const g = new Map<string, NewsItem[]>();
    for (const item of items) {
      const key = dateKey(itemTs(item));
      const bucket = g.get(key) ?? [];
      bucket.push(item);
      g.set(key, bucket);
    }
    for (const bucket of g.values()) {
      bucket.sort((a, b) => {
        const tDiff = itemTs(b) - itemTs(a);
        if (tDiff !== 0) return tDiff;
        const titleDiff = a.title.localeCompare(b.title);
        if (titleDiff !== 0) return titleDiff;
        return (a.source ?? "").localeCompare(b.source ?? "");
      });
    }
    const dates = [...g.keys()].sort((a, b) => b.localeCompare(a));
    return { grouped: g, sortedDates: dates };
  }, [items]);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="news-template news-template--newspaper">
      <header className="newspaper-masthead">
        <div className="newspaper-masthead__kicker">The Bunny Gazette</div>
        <div className="newspaper-masthead__date">{today}</div>
      </header>
      {sortedDates.map((iso) => {
        const dateItems = grouped.get(iso)!;
        const [hero, ...rest] = dateItems;
        return (
          <section key={iso} className="newspaper-section">
            <h2 className="newspaper-section__title">{formatSectionDate(iso)}</h2>
            {hero && (
              <div className="newspaper-section__hero">
                <NewsItemCard
                  item={hero}
                  topic={topicById.get(hero.topicId)}
                  showTopicBadge
                  reaction={reactions[hero.id] ?? null}
                  onReact={onReact ? (r) => onReact(hero.id, r) : undefined}
                />
              </div>
            )}
            {rest.length > 0 && (
              <div className="newspaper-section__columns">
                {rest.map((item) => (
                  <NewsItemCard
                    key={item.id}
                    item={item}
                    topic={topicById.get(item.topicId)}
                    showTopicBadge
                    compact
                    reaction={reactions[item.id] ?? null}
                    onReact={onReact ? (r) => onReact(item.id, r) : undefined}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
