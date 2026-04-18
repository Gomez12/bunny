import type { NewsItem, NewsTopic } from "../../api";
import NewsItemCard from "./NewsItemCard";

type Props = {
  items: NewsItem[];
  topics: NewsTopic[];
};

export default function NewsTemplateList({ items, topics }: Props) {
  const topicById = new Map(topics.map((t) => [t.id, t]));
  return (
    <div className="news-template news-template--list">
      {items.map((item) => (
        <NewsItemCard
          key={item.id}
          item={item}
          topic={topicById.get(item.topicId)}
          showTopicBadge
        />
      ))}
    </div>
  );
}
