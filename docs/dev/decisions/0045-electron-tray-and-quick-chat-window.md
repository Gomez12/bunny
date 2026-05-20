# ADR 0045 — Electron tray + Quick Chat mini-window

**Status:** Accepted
**Date:** 2026-05-09

## Context

ADR 0042 introduced the Electron desktop client (`electron/`) as a single-window
shell that loads the running Bunny server. For day-to-day use the user wanted:

- a system tray icon on macOS, Windows and Linux so Bunny can keep running in
  the background without taking a dock / taskbar slot;
- a small Quick Chat window that opens straight from the tray (or a global
  hotkey) to ask one quick question, without losing context of whatever app
  the user is currently in;
- the ability to keep that mini-window open *next to* the full Bunny UI when
  the latter is already open — the two should not be mutually exclusive.

The web side already supports Quick Chat as a regular session with the
`is_quick_chat` flag on `session_visibility` (auto-hidden after 15 min by
`session.hide_inactive_quick_chats`, ADR 0023). We can reuse that without
touching the backend.

## Decision

1. The Electron client gains a cross-platform `Tray` icon. The tray is the
   primary lifecycle anchor: closing the main window hides it to the tray
   instead of quitting (configurable, default on). Quitting only happens
   through the tray menu's `Quit` item or `Cmd+Q`.

2. A second, smaller `BrowserWindow` (520×660) renders the Quick Chat. It
   loads the same server URL with a `?mini=1` query parameter; the React app
   branches at boot to `MiniApp` for that flag and renders a stripped-down
   shell containing the existing `ChatTab` in a new `compact` mode (no
   sidebar, no admin Mine/All toggle, tighter paddings).

3. The mini and main windows are independent. `toggleMiniWindow()` never
   touches `mainWindow`. The mini's *Expand* button calls
   `mini:openMain` which shows / focuses the main window with the same
   `sessionId` (via a `localStorage` write + reload) and **leaves the
   mini-window open** — the user closes it themselves with *Hide* / X.

4. A configurable global hotkey toggles the Quick Chat window. The default is
   `CommandOrControl+B`. Because Electron's `globalShortcut.register` captures
   the binding system-wide as long as Bunny runs, that conflicts with `Cmd+B`
   in editors (Bold). We document this in the in-app Settings hint and let the
   user reassign or disable the binding.

5. Client-side preferences (hotkey, close-to-tray) live in the existing
   `config.json` next to `serverUrl`. They never trigger an `app.relaunch()`
   — the connection-URL flow keeps that behaviour because the Chromium
   `unsafely-treat-insecure-origin-as-secure` switch must be applied before
   the browser process starts. A new `Settings…` window
   (`electron/ui/settings.html`) lets users edit these without resetting the
   connection.

## Implementation

### Tray (`electron/main.js`)

`buildTray()` is wrapped in a try/catch; some Linux desktop environments
(notably modern GNOME without `AppIndicatorAndKStatusNotifierItem`) reject
tray creation at runtime. When that happens the warning is logged, `tray`
stays `null`, and `window-all-closed` falls back to `app.quit()` so the
app is still usable as a normal single-window app.

The macOS tray uses `tray-iconTemplate.png` so the OS auto-tints it for
dark/light menu-bar palettes; other platforms get the colour
`tray-icon.png`. v1 ships these as 32×32 placeholders derived from the
existing app icon — they should be replaced with proper monochrome
templates (16/22 px @1x and @2x) before public distribution.

### Lifecycle

```
mainWindow.on('close')           → if !isQuitting && closeToTray && tray
                                     → preventDefault + win.hide()
                                       (and app.dock.hide() on macOS)
app.on('window-all-closed')      → if !tray || isQuitting: app.quit()
app.on('before-quit')            → isQuitting = true
tray menu "Quit"                 → isQuitting = true; app.quit()
```

`mainWindow.on('show')` re-shows the dock icon on macOS (counterpart to the
hide-on-close behaviour).

### Mini-window URL

The mini window calls `loadURL(<serverUrl>?mini=1)`. `web/src/main.tsx`
reads `window.location.search`, and on `?mini=1` renders `MiniApp` instead
of `App`. `MiniApp` runs its own auth check (`fetchMeInfo`), seeds /
re-uses a Quick Chat session via `localStorage["bunny.miniSessionId"]`,
and renders a header (New / Expand / Hide) plus `ChatTab compact`.

Without an Electron bridge available (e.g. the user manually navigates to
`?mini=1` in a regular browser tab), *Expand* falls back to opening a new
tab with the session as a deep link, and *Hide* calls `window.close()`.

### Compact ChatTab

Single-prop addition: `compact?: boolean`. In compact mode:

- the `<SessionSidebar>` is not rendered;
- the root `<div>` gains `chat--compact`;
- the admin scope state stays at `"mine"` so the read-only banner never
  shows.

All edit / regenerate / fork / SSE plumbing is unchanged.

### IPC

Preload exposes:

```
electronAPI.isMiniWindow()        // sync, reads --bunny-mini argv flag
electronAPI.openMainWindow({ sessionId? })
electronAPI.closeMiniWindow()
electronAPI.getHotkey() / setHotkey(accel)   // accel === '' disables
electronAPI.getCloseToTray() / setCloseToTray(bool)
```

`setHotkey` returns the boolean result of `globalShortcut.register` so the
Settings UI can surface a "could not register" error inline.

### Hotkey state

`config.hotkey` has three states:
- **field absent** → use `DEFAULT_HOTKEY` (`CommandOrControl+B`);
- **empty string** → explicitly disabled, no global shortcut;
- **non-empty string** → custom binding.

`setHotkey(null)` writes `''` (disabled). `globalShortcut.unregisterAll()`
runs both at boot before the new binding and on `will-quit`.

## Consequences

- One additional config file field set (`hotkey`, `closeToTray`); no
  schema or backend changes.
- Tray-less Linux DEs degrade to standard quit-on-close behaviour without
  a code path of their own.
- Electron is now stateful in the user's OS: closing the main window can
  feel "where did the app go?" until the user notices the tray icon.
  Mitigated by (a) on macOS the dock re-shows on `activate`, (b) the
  Settings window lets users disable close-to-tray.
- Default `Cmd+B` will silently shadow Bold in editors while Bunny runs.
  Documented in the Settings hint; user can change or disable.
- No backend or DB-schema changes. Quick Chat reuses the existing
  `is_quick_chat` flag and auto-hide behaviour.

## Alternatives rejected

**Popover-style mini-window (auto-hide on blur).** Rejected — the user
explicitly prefers a persistent window so they can switch to a browser /
document mid-question without losing the chat.

**Implementing the mini-shell as a separate Vite entry / chunk.** Would
duplicate auth, SSE, theme, and `useSSEChat` plumbing. The cost of loading
the rest of `App.tsx` lazy-imported deps in a 520×660 window is negligible
compared to the maintenance cost of two parallel React trees.

**Storing client preferences in the server DB.** Hotkey and close-to-tray
are inherently client-side; storing them on the server would imply
syncing across machines, which is undesirable for a per-machine UX
binding.

## Related

- ADR 0042 — Electron client baseline.
- ADR 0023 — Quick Chat session flag and auto-hide behaviour.
