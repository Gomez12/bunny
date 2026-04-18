import type { ReactNode } from "react";
import Rabbit from "./Rabbit";

/**
 * Empty state. See docs/styleguide.md §4 (Components) and §8.
 * Always uses the rabbit mascot so "nothing here yet" still feels on-brand.
 */
type Props = {
  title: string;
  description?: string;
  action?: ReactNode;
  size?: "sm" | "md";
};

export default function EmptyState({ title, description, action, size = "md" }: Props) {
  const rabbitSize = size === "sm" ? 80 : 120;
  return (
    <div className={`empty-state empty-state--${size}`}>
      <div className="empty-state__rabbit" aria-hidden="true">
        <Rabbit size={rabbitSize} />
      </div>
      <h3 className="empty-state__title">{title}</h3>
      {description ? <p className="empty-state__desc">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
