# Design system

## At a glance

The **canonical** design system lives in [`docs/styleguide.md`](../../styleguide.md). This page is the dev-oriented orientation layer — what to look up where, and the rules you need to know before you open a PR.

## Where the tokens live

- `web/src/styles.css` — CSS custom properties (`--color-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--font-*`). All token definitions are top-of-file; consumers reference them by name.
- `docs/styleguide.md` — the canonical values + their semantics + when to use which.

Never hard-code colours or spacing in a component. If you need a value the tokens don't cover, add a token first and update the styleguide in the same PR.

## Type scale

One sans serif stack, one monospace stack, one heading scale. See the styleguide for the exact sizes. Rules:

- Body text: `--font-body` (sans). Never fall back to the system serif.
- Code: `--font-mono`.
- Headings: `--font-heading` scale (h1…h4). No custom heading sizes.

## Spacing scale

`--space-0` through `--space-8`, each 4 px. Use the scale:

```css
padding: var(--space-4);      /* 16 px */
gap: var(--space-2);          /* 8 px */
```

Raw px values are a code smell; they'll fail review.

## Colour semantics

Tokens are semantic, not raw palette:

- `--color-bg`, `--color-bg-elevated` — surfaces.
- `--color-fg`, `--color-fg-muted` — text.
- `--color-accent` — the brand accent (rabbit purple).
- `--color-border`, `--color-border-strong`.
- `--color-danger`, `--color-warning`, `--color-success`.

Do not reach for a raw palette. The themes (light + dark) rebind the same semantic tokens.

## Shadows and radii

- `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-full`.
- `--shadow-sm` / `--shadow-md` / `--shadow-lg` — used sparingly. Flat UI by default.

## Theme

`bunny.theme` in `localStorage` flips a `data-theme` attribute on `<html>`. Both `light` and `dark` palettes are defined via the same token names; consumers need no branches. See `web/src/styles.css` `[data-theme="dark"]` block.

## Rules

- **Tokens over raw values.** Every colour, spacing, radius, shadow references a token.
- **No inline styles except for runtime-dynamic values** (e.g. a progress bar width). Stylesheet over `style={{ … }}`.
- **Accent is rarely used.** The rabbit-purple is a brand signal — save it for CTAs and active states.
- **Motion is subtle.** 150 ms ease-out for hovers; longer for entrance. See the styleguide.

## Styleguide change-log

When you ship a UI change that adds/removes tokens, components, or icon usage:

1. Update `web/src/styles.css` / the component.
2. Update `docs/styleguide.md` in the same PR.
3. Add a dated entry to the styleguide's change log.

A PR that adds a token without a styleguide entry is rejected.

## Related

- [`../../styleguide.md`](../../styleguide.md) — canonical.
- [`./icons-and-rabbit.md`](./icons-and-rabbit.md) — icon rules on top of the token system.
- [`./component-library.md`](./component-library.md) — shared primitives that bundle tokens into a re-usable shape.
