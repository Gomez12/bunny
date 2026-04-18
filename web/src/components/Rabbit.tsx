/**
 * Rabbit mascot. See docs/styleguide.md §6 for sanctioned placements:
 *   - brand logo (20 px)
 *   - background watermark (~200 px, opacity 0.04, set by CSS)
 *   - empty state (120 px)
 *   - auth hero (160 px)
 *
 * Renders inline SVG so `currentColor` drives the body and the parent's
 * font-size / color controls the appearance. Facial features (eyes, nose,
 * mouth) use fixed black/white tones for readability on the dark palette.
 */
type Props = {
  size?: number;
  className?: string;
  title?: string;
};

export default function Rabbit({ size = 24, className, title = "bunny" }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 140"
      width={size}
      height={Math.round((size * 140) / 120)}
      fill="currentColor"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <ellipse cx="38" cy="32" rx="10" ry="28" transform="rotate(-12 38 32)" />
      <ellipse cx="82" cy="32" rx="10" ry="28" transform="rotate(12 82 32)" />
      <ellipse cx="38" cy="36" rx="4" ry="18" transform="rotate(-12 38 36)" opacity="0.35" />
      <ellipse cx="82" cy="36" rx="4" ry="18" transform="rotate(12 82 36)" opacity="0.35" />
      <ellipse cx="60" cy="82" rx="34" ry="32" />
      <circle cx="38" cy="94" r="8" opacity="0.15" />
      <circle cx="82" cy="94" r="8" opacity="0.15" />
      <circle cx="48" cy="80" r="2.6" opacity="0.85" fill="#000" />
      <circle cx="72" cy="80" r="2.6" opacity="0.85" fill="#000" />
      <circle cx="48.8" cy="79.2" r="0.8" fill="#fff" opacity="0.9" />
      <circle cx="72.8" cy="79.2" r="0.8" fill="#fff" opacity="0.9" />
      <path d="M58 92 Q60 95 62 92 Q61 96 60 96 Q59 96 58 92 Z" opacity="0.85" fill="#000" />
      <path
        d="M54 99 Q60 104 66 99"
        fill="none"
        stroke="#000"
        strokeOpacity="0.7"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" fill="none">
        <line x1="30" y1="96" x2="44" y2="98" />
        <line x1="30" y1="101" x2="44" y2="101" />
        <line x1="76" y1="98" x2="90" y2="96" />
        <line x1="76" y1="101" x2="90" y2="101" />
      </g>
      <ellipse cx="46" cy="124" rx="8" ry="6" />
      <ellipse cx="74" cy="124" rx="8" ry="6" />
    </svg>
  );
}
