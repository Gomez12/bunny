# Add a UI component

## When you need this

Your tab needs a new piece of UI. The question: does it belong under `web/src/components/` (shared) or inline in the tab (local)?

## Decide: shared vs local

Put it under `web/src/components/` **only if** one of:

- More than one tab will use it.
- It's a clearly re-usable primitive (a card, a dialog, a status pill, a badge).
- It's large enough that splitting the tab's file improves readability.

Put it **inline in the tab** (or a `web/src/tabs/<tab>/*.tsx` sub-file) **if**:

- Only this tab uses it.
- It encodes tab-specific business logic.
- It's small (<~100 lines).

When in doubt, start local. Promote to `components/` later.

## Steps

1. **Create the file.** Name it after the role: `MyThing.tsx`, `MyThingDialog.tsx`, `MyThingCard.tsx`.
   ```tsx
   // web/src/components/MyThing.tsx
   import { ICON_DEFAULTS, Sparkles } from "../lib/icons";

   export type MyThingProps = {
     label: string;
     onClick: () => void;
   };

   export default function MyThing({ label, onClick }: MyThingProps) {
     return (
       <button className="my-thing" onClick={onClick}>
         <Sparkles {...ICON_DEFAULTS} />
         <span>{label}</span>
       </button>
     );
   }
   ```

2. **Style with tokens.** In `web/src/styles.css`:
   ```css
   .my-thing {
     display: inline-flex;
     align-items: center;
     gap: var(--space-2);
     padding: var(--space-2) var(--space-3);
     border-radius: var(--radius-md);
     color: var(--color-fg);
     background: var(--color-bg-elevated);
   }
   ```
   No raw colour values. No raw px (use `--space-*`).

3. **Re-export types with the component.** Keeps consumers from importing from multiple files.

4. **Test.** If the component has logic beyond prop-forwarding, a component test pays off. Otherwise skip.

## Rules

- **Icons through `web/src/lib/icons.ts`.** Never import `lucide-react` directly.
- **Tokens over raw values.** Every colour / spacing / radius / shadow references a CSS variable.
- **Primitives respect `currentColor`.** A consumer should be able to change the parent colour and the component tints accordingly.
- **Primitives don't own network state.** Data in via props; mutations via callbacks.
- **Dialogs use the native `<dialog>`.** Don't invent a new modal container.

## Patterns to reuse

Before writing a new component, check [`../ui/patterns.md`](../ui/patterns.md) — your UI probably maps to an existing pattern (sidebar-list-plus-detail, composer, card grid, etc.). The existing primitives in [`../ui/component-library.md`](../ui/component-library.md) compose cleanly.

## Styleguide update

If the new component introduces a new token, a new pattern, or a new icon usage, update `docs/styleguide.md` in the same PR and add a dated entry to its change log. PRs that expand the visual system without a styleguide update are rejected.

## Validation

- The component renders in the tab it's used in.
- It respects `[data-theme="dark"]` — flip the theme via the sidebar's theme toggle to confirm.
- The styleguide change-log has a dated entry if the visual system changed.

## Related

- [`../ui/component-library.md`](../ui/component-library.md)
- [`../ui/patterns.md`](../ui/patterns.md)
- [`../ui/icons-and-rabbit.md`](../ui/icons-and-rabbit.md)
- [`../ui/design-system.md`](../ui/design-system.md)
- [`../../styleguide.md`](../../styleguide.md)
