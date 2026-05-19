# Spotted bugs / smells (unfixed)

Per CLAUDE.md convention: bugs noticed but not fixed in the current task get appended here so they don't quietly disappear. Format: `- [file:line] short description`.

## 2026-05-08 — perf + style audit triage

Findings from the codebase-wide audit (backend hot paths, frontend render/memory, styleguide). Items below were medium/low impact and out of scope for the bundled fix pass; they belong in their own follow-up branches.

### Backend perf

- [src/memory/recall.ts:82] `missingIds` IN-clause has no defensive cap; pathological RRF degeneracy could produce a 1000+ entry IN list. Add `if (missingIds.length > 1000) missingIds = missingIds.slice(0, 1000);`.
- [src/agent/loop.ts:102] `skillCatalogCache` Map grows unbounded per-project; only the per-entry 30 s TTL gates writes, never evicts. Add LRU cap (e.g. max 100 entries).
- [src/memory/skill_assets.ts:62] `assetsCache` mtime-keyed Map has no LRU/TTL; every transient skill load stays cached.
- [src/memory/agent_assets.ts:113] Same unbounded mtime-cache pattern as skill_assets.
- [src/telegram/poll_handler.ts:46] `sweepSeenUpdates` runs every minute per process; with multiple poll workers this contends on the same DELETE. Move to a separate hourly task or add a lease.
- [src/memory/refresh_handler.ts:80-125] `listActiveUserProjectPairs` CTE re-aggregates the full `messages` table per tick; on 1M+ rows this is 100–500 ms. Consider materializing active-pair state.
- [src/web_news/site_monitor.ts:88] `NodeHtmlMarkdown.translate(html).slice(...)` runs on potentially-large HTML; pre-cap `html.length` before parsing.
- [src/agent/loop.ts:449] `ensureGlobalGate(cap)` called per `runAgent` invocation — micro-optimization opportunity to initialize once at server boot.
- [src/memory/recall.ts] Embedding for `query` is regenerated per turn; identical-prompt edge cases would benefit from a 60 s TTL cache keyed by query hash.
- [src/planning/report_snapshot_handler.ts:34] `selectActivePlanningProjectIds` has no LIMIT; on instances with thousands of planning projects the snapshot tick materializes them all in memory.
- [src/memory/contacts.ts:970] Dynamic SELECT-string built via `SELECT_COLS.split(",").map(...).join(...)` — fragile to schema drift. Use explicit column list.
- [src/scheduler/ticker.ts:124] `Promise.allSettled` has no per-handler timeout — a hung handler blocks the next tick by 60 s. Add `Promise.race` with a 30 s ceiling.
- [src/memory/refresh_handler.ts:232] `formatMessages` does not clamp individual `message.content`; a 100 KB pasted log would inflate the merge prompt before downstream clamp.

### Frontend render / memory

- [web/src/hooks/useTranslations.ts:126] Polling `useEffect` lists `refresh` (which closes over `activeLangInitialised`) in deps — interval can stack if the dep flips while a poll is in flight.
- [web/src/tabs/ChatTab.tsx] No virtualization for `history.map(...)` — 100+ turns each render every full session. Needs `react-window` or a windowing hook (own ADR — adds dep).
- [web/src/tabs/BoardTab.tsx:200-322] Drag end triggers 3–5 sequential state updates (`setDragging` → `setBoard(optimistic)` → fetch → `setBoard(final)`). Consolidate into two batched updates.
- [web/src/tabs/ChatTab.tsx:525-562] `onSelectIndex={(idx) => setRegenIndex(...)}` defined inline inside the loop — new function identity every render. Wrap in `useCallback`.
- [web/src/tabs/BoardTab.tsx:361-365] `visibleLanes` computed inside an IIFE in JSX — sort runs every render. Extract to `useMemo`.
- [web/src/tabs/planning/PlanningSuggestionPanel.tsx] Item handlers (`setMode`, `setShowHidden` etc.) recreate per render; minor — but a `useCallback` cleanup would reduce churn.

### Styleguide / CSS

- [web/src/styles.css] Spacing-scale outliers: 1px (line 389 `.modal-badge`), 2px (line 433 `.bubble-actions`), 3px (line 5388 `.news-reaction-btn`), 5px (line 496 `.chat-quick-badge`, line 5507 `.news-list__item`), 6px / 7px / 13px / 18px / 22px scattered. Styleguide §1 says scale = 4 / 8 / 12 / 16 / 20 / 24 / 32. Either add an explicit `--micro` token for badges or homogenize.
- [web/src/tabs/LogsTab.tsx:4] Inline `style={{ padding: "1rem", textAlign: "center" }}` on table cell — should be a CSS class.
- [web/src/tabs/diagrams/DiagramStylePanel.tsx] Repeated inline `style={{ marginTop: 6 }}` — extract `.dn-style-panel__separator` class with scale-aligned spacing.
- [web/src/tabs/FeedPatternsAdmin.tsx] Ad-hoc inline table styling (`<th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>`) — needs a shared `.admin-table` primitive.
- [web/src/tabs/FilesTab.tsx:240] `📁` and `📄` emojis as folder/file glyphs — consistent with the now-fixed lock case, should also become `<Folder>` / `<FileText>` from the icon barrel.
- [web/src/styles.css:862] `.mention-popup__badge--agent` uses bare `#6f56d8` — semantic brand-purple variant; add a token if more agent-tinted UI surfaces appear.
- [web/src/styles.css] Single 11k-line CSS file — no per-feature splitting. No urgent fix; flagged for if the file becomes unwieldy.
- [web/src/components/Modal.tsx ecosystem] No shared `<FormField>` primitive — every dialog reinvents label/input/error markup via `.modal input` + `.modal label` rules. Optional refactor; would reduce inline ad-hoc form layouts.

### Audit follow-up notes

- **B2 (planning suggestion refresh sequential):** investigated and not fixed. `buildAndStoreSuggestion` is fully synchronous (DB + `computeSchedule` are sync), so `Promise.all` doesn't help in single-threaded JS. Tick is already capped at `cfg.planning.suggestionRefreshBatchSize ?? 5`. The audit overstated this finding.
- **B4 (planning_suggestions stale-id query):** the GROUP BY MAX scan is real but already capped at `LIMIT ?` (5 by default at the call site). Real fix is materialization (own ADR).
- **S6 (diagram node colours):** `--diagram-ok` / `--diagram-warn` / `--diagram-err` tokens were added defensively, but the `.dn-node--alert` / `--success` / `--error` selectors the audit referenced do not exist in `styles.css`. The tokens are reserved for if/when status-coloured node variants are introduced.
