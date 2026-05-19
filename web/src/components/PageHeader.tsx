import type { ReactNode } from "react";

/**
 * Shared tab header. Title, optional description, optional right-aligned
 * actions. See docs/dev/styleguide/README.md §3 "Page header".
 *
 * Replaces hand-rolled `<h1>` + toolbar markup that previously diverged
 * between tabs (18 px vs 20 px titles, missing descriptions, ad-hoc
 * action rows).
 */
type Props = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Extra class for the wrapper (e.g. tab-scoped layout adjustments). */
  className?: string;
};

export default function PageHeader({
  title,
  description,
  actions,
  className,
}: Props) {
  const cls = className ? `page-header ${className}` : "page-header";
  return (
    <header className={cls}>
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {description ? (
          <p className="page-header__description">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
