import rabbitUrl from "../assets/rabbit-watermark.svg";

/**
 * Rabbit mascot. See docs/dev/styleguide/README.md §6 for sanctioned placements:
 *   - brand logo (20 px)
 *   - background watermark (~240 px, opacity 0.06, set by CSS)
 *   - empty state (120 px)
 *   - auth hero (160 px)
 *
 * Renders the illustrated grey rabbit head SVG as an `<img>`. The asset has
 * a fixed grey palette — `currentColor` no longer applies, so wrappers that
 * used to tint via `color: var(--accent)` have no visual effect any more.
 */
type Props = {
  size?: number;
  className?: string;
  title?: string;
};

export default function Rabbit({
  size = 24,
  className,
  title = "bunny",
}: Props) {
  return (
    <img
      src={rabbitUrl}
      width={size}
      height={size}
      alt={title}
      className={className}
      draggable={false}
    />
  );
}
