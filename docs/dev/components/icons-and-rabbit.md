# Icons and rabbit

## Icons

Source: **`lucide-react` only**, imported via the **barrel at `web/src/lib/icons.ts`**.

### The rule

Never `import … from "lucide-react"`. Always go through the barrel:

```ts
import { Plus, Search, ICON_DEFAULTS } from "../lib/icons";
```

Why: every new icon is announced in one file. Review catches "do we already have one for this?" and keeps bundle size auditable.

### Defaults

```ts
export const ICON_DEFAULTS = {
  size: 18,
  strokeWidth: 1.75,
} as const;
```

- **Size**: 18 px default, 16 px inline in text, 20 px in the brand lockup.
- **Stroke-width**: 1.75.
- **Colour**: `currentColor` — never hard-code fills.

Spread `ICON_DEFAULTS` to pick up both:

```tsx
<Plus {...ICON_DEFAULTS} />
```

### Adding a new icon

1. Find a matching icon on [lucide.dev](https://lucide.dev). Prefer an existing icon in the barrel over adding a new one.
2. Re-export it from `web/src/lib/icons.ts` in the correct section (Navigation / Actions / Status / Domain). Keep the sections ordered roughly by usage.
3. Import the new name via the barrel in your component.
4. PRs that bypass the barrel fail review.

### Current barrel

See `web/src/lib/icons.ts` for the full list. Sections:

- **Navigation** — nav-group icons (MessageCircle, Kanban, Clock, FileText, Palette, Folder, Users, Package, Library, Newspaper, LayoutDashboard, Settings).
- **Actions** — Plus, Search, Pencil, Trash2, Download, Upload, Copy, Check, X, chevrons, Play, Pause, RefreshCw, RotateCcw, Eraser, ExternalLink.
- **Status** — AlertCircle, AtSign, Bell, BellRing, Info, CheckCircle, Loader2.
- **Domain** — Lock, User, Bot, Sparkles, LogOut, Menu, Globe, Languages, Sun, Moon, Send, LinkIcon.

## The rabbit

The rabbit mascot is the brand motif. It appears in five contexts:

1. **Brand logo** — sidebar top-left, 20 px. `<Rabbit size={20} />` inside `.nav__brand-rabbit`.
2. **Watermark** — 0.04-opacity, absolute-positioned inside `.app-shell__main`. Skipped on the Dashboard via `.app-shell__main--dense`.
3. **Empty states** — `<EmptyState>` primitive uses a larger rabbit. See `web/src/components/EmptyState.tsx`.
4. **Login / change-password hero** — pages/* surfaces.
5. **Loading states** — sparingly; the spinner (`Loader2`) is the default.

### Placement rules

- Never reflow layout to accommodate the rabbit. It's decorative, not structural.
- Watermark opacity is 0.04 — pinned. Don't bump it.
- On the Dashboard, the main area is `.app-shell__main--dense` which explicitly removes the watermark; the Dashboard is information-dense and the mascot would add noise.

### SVG source

`web/src/assets/rabbit.svg`. The component (`web/src/components/Rabbit.tsx`) accepts a `size` prop and respects `currentColor`, so it tint-matches the surrounding text.

## Related

- [`../../styleguide.md`](../../styleguide.md) §5 (icons) and §7 (rabbit) — canonical.
- [`./shell-and-navigation.md`](./shell-and-navigation.md) — where the rabbit logo sits in the nav.
- [`./component-library.md`](./component-library.md) — `EmptyState` API.
