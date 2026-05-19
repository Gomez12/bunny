import type { ReactNode } from "react";

/**
 * Shared segmented sub-tab control. See docs/dev/styleguide/README.md §3.
 *
 * Renders a `role="tablist"` whose buttons carry `role="tab"` and
 * `aria-selected`. Use this everywhere a tab body splits into sub-sections
 * (Workspace → Projects/Agents/Skills/Memory/Integrations, Notifications →
 * All/Unread, Web News → template picker, etc.) — never roll a new
 * subtab CSS class family.
 */
export interface SubTabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Optional badge / count rendered next to the label. */
  trailing?: ReactNode;
  /** When true, the tab renders disabled. */
  disabled?: boolean;
}

interface Props<T extends string> {
  items: ReadonlyArray<SubTabItem<T>>;
  current: T;
  onChange: (id: T) => void;
  /** Required for screen readers. */
  ariaLabel: string;
  /** Optional class override on the wrapper. */
  className?: string;
}

export default function SubTabs<T extends string>({
  items,
  current,
  onChange,
  ariaLabel,
  className,
}: Props<T>) {
  const cls = className ? `subtabs ${className}` : "subtabs";
  return (
    <nav className={cls} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.id === current;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            className={`subtab ${active ? "subtab--active" : ""}`}
            onClick={() => {
              if (!item.disabled) onChange(item.id);
            }}
          >
            {item.label}
            {item.trailing ? (
              <span className="subtab__trailing">{item.trailing}</span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
