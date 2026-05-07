import type { NewsItem, NewsTopic, NewsReaction } from "../../api";
import NewsItemCard from "./NewsItemCard";

type Props = {
  items: NewsItem[];
  topics: NewsTopic[];
  reactions?: Record<number, NewsReaction>;
  onReact?: (itemId: number, reaction: NewsReaction | null) => void;
};

export default function NewsTemplateList({ items, topics, reactions = {}, onReact }: Props) {
  const topicById = new Map(topics.map((t) => [t.id, t]));
  return (
    <div className="news-template news-template--list">
      {items.map((item) => (
        <NewsItemCard
          key={item.id}
          item={item}
          topic={topicById.get(item.topicId)}
          showTopicBadge
          reaction={reactions[item.id] ?? null}
          onReact={onReact ? (r) => onReact(item.id, r) : undefined}
        />
      ))}
    </div>
  );
}
