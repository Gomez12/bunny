import type { NewsItem, NewsTopic } from "../../api";
import NewsItemCard from "./NewsItemCard";

type Props = {
  items: NewsItem[];
  topics: NewsTopic[];
};

export default function NewsTemplateNewspaper({ items, topics }: Props) {
  const grouped = new Map<number, NewsItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.topicId) ?? [];
    bucket.push(item);
    grouped.set(item.topicId, bucket);
  }
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
      {topics
        .filter((t) => (grouped.get(t.id) ?? []).length > 0)
        .map((topic) => {
          const topicItems = grouped.get(topic.id) ?? [];
          const [hero, ...rest] = topicItems;
          return (
            <section key={topic.id} className="newspaper-section">
              <h2 className="newspaper-section__title">{topic.name}</h2>
              {topic.description && (
                <p className="newspaper-section__lede">{topic.description}</p>
              )}
              {hero && (
                <div className="newspaper-section__hero">
                  <NewsItemCard item={hero} topic={topic} />
                </div>
              )}
              {rest.length > 0 && (
                <div className="newspaper-section__columns">
                  {rest.map((item) => (
                    <NewsItemCard
                      key={item.id}
                      item={item}
                      topic={topic}
                      compact
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
