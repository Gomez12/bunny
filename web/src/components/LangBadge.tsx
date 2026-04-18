/**
 * Compact 2-letter language pill. Renders next to entity titles in list rows
 * so users see the source language at a glance. See docs/styleguide.md.
 */

interface Props {
  lang: string;
  title?: string;
  className?: string;
}

export default function LangBadge({ lang, title, className }: Props) {
  const upper = (lang ?? "").toUpperCase();
  if (!upper) return null;
  return (
    <span
      className={`lang-badge${className ? ` ${className}` : ""}`}
      title={title ?? `Language: ${upper}`}
    >
      {upper}
    </span>
  );
}
