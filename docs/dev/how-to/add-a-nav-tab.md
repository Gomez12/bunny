# Add a nav tab

## When you need this

A new top-level tab in the sidebar — Dashboard, Files, News, etc. all followed this path.

## Steps

1. **Build the tab component.** Create `web/src/tabs/MyTab.tsx`:
   ```tsx
   export default function MyTab() {
     return <div className="tab">My tab content</div>;
   }
   ```
   If the tab needs a secondary column (list + detail), wire that inside the tab, not at the shell level. See `../ui/patterns.md` pattern 1.

2. **Add the icon to the barrel.** In `web/src/lib/icons.ts`, re-export the lucide icon in the right section (Navigation):
   ```ts
   export {
     // Navigation
     …,
     Sparkles as MyTabIcon,     // or the actual lucide name
   } from "lucide-react";
   ```

3. **Extend `NavTabId`.** In `web/src/components/Sidebar.tsx`:
   ```ts
   export type NavTabId =
     | "chat"
     | "board"
     | …
     | "my_tab";
   ```

4. **Add to `NAV`.** In the same file:
   ```ts
   const NAV: NavGroup[] = [
     …,
     {
       label: "Content",
       items: [
         …,
         { id: "my_tab", label: "My tab", icon: MyTabIcon },
       ],
     },
   ];
   ```
   Pick the group deliberately (Overview / Work / Content / Configure). Read [`../ui/shell-and-navigation.md`](../ui/shell-and-navigation.md) if unsure.

5. **Wire the router.** In `web/src/App.tsx`:
   ```tsx
   import MyTab from "./tabs/MyTab";
   // …
   {activeTab === "my_tab" && <MyTab />}
   ```

6. **If the old tab id was renamed**, add a `LEGACY_TAB_ALIAS` entry so external links don't break:
   ```ts
   const LEGACY_TAB_ALIAS: Record<string, NavTabId> = {
     …,
     old_name: "my_tab",
   };
   ```
   Never remove entries from this map.

7. **Persist the tab.** `bunny.activeTab` in `localStorage` — the router does this for you. Ensure the tab id is a valid `NavTabId`.

8. **Update docs.** Add an entity page under `docs/dev/entities/` (or a concept page under `docs/dev/concepts/` if it's a cross-cutting surface). Link from `docs/dev/README.md`.

## Rules

- **Icons via the barrel only.** Never `import … from "lucide-react"` directly.
- **`NavTabId` is the union.** Never hard-code a tab string outside it.
- **Legacy aliases stay forever.** Removing one breaks saved links.
- **Deep links must keep working.** If your tab takes query params (`project`, `session`), handle them in the tab mount; `App.tsx` only parses the URL once on boot.

## Validation

- Open the app. The new tab is visible in the sidebar. Click it → it renders.
- Reload → the tab stays selected (localStorage persistence).
- Set the old alias in `localStorage.bunny.activeTab = "old_name"` → reload → lands on `my_tab` (alias forward).
- Deep-link `?tab=my_tab` lands on the tab.

## Related

- [`../ui/shell-and-navigation.md`](../ui/shell-and-navigation.md)
- [`../ui/icons-and-rabbit.md`](../ui/icons-and-rabbit.md)
- [`../ui/patterns.md`](../ui/patterns.md)
- [ADR 0020 — UI redesign & styleguide](../../adr/0020-ui-redesign-and-styleguide.md)
