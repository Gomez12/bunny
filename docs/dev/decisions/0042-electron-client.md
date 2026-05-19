# ADR 0042 — Electron Desktop Client

**Status:** Accepted
**Date:** 2026-05-08

## Context

ADR 0017 introduced a Tauri v2 desktop client (`client/`) that connects to a
running Bunny server. The Tauri client uses the OS native webview (WKWebView on
macOS, WebView2 on Windows), which, like a browser, enforces the W3C secure
context requirement for `navigator.mediaDevices.getUserMedia()`: the API is
unavailable on non-HTTPS origins.

The diary subsystem (ADR 0041) records audio via `getUserMedia()`. Since Bunny
servers typically run over plain HTTP on a LAN address, microphone access is
non-functional in the Tauri client. The Tauri v2 API provides no mechanism to
override secure-context checks on a per-origin basis.

## Decision

Add an Electron desktop client under `electron/` at the project root. It
provides identical functionality to the Tauri client (server URL setup,
navigation interception, system notifications, reset connection) and additionally
grants microphone access on HTTP server connections.

The Tauri client is retained in parallel. Once the Electron client is proven
stable in production, the Tauri client can be removed.

## Implementation

### Multiplatform & Portability

Each build must run natively on its target OS (no cross-compilation). Artifacts:

| Platform | arch | Artifact | Portable |
|----------|------|----------|---------|
| macOS | arm64, x64 | `.dmg` + `.zip` | `.zip` = drag `.app` anywhere |
| Windows | x64 | portable `.exe` | Yes — no installer, config in `%APPDATA%\Bunny` |
| Linux | x64, arm64 | `AppImage` | Yes — single file, runs without install |

### Key Implementation Choices

**1. `app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', origin)`**

This is the load-bearing mechanism. Chromium checks whether an origin is a
secure context _before_ consulting the permission handler, so
`session.setPermissionRequestHandler()` alone is insufficient for HTTP origins.
The switch must be registered before the browser process initialises, which
means calling it synchronously before `app.whenReady()`. The saved server URL is
read from `config.json` with a synchronous `fs.readFileSync` at the module
top-level for this purpose.

**2. Relaunch on URL change**

Because Chromium command-line switches are fixed at process start, any change
to the server URL (new setup entry or Reset Connection) must persist the new URL
and call `app.relaunch(); app.exit(0)`. The relaunched process reads the new URL
and registers its origin before Chromium initialises. This adds approximately
1 second of latency to the infrequent setup and reset flows.

**3. CommonJS for `main.js` and `preload.js`**

`electron-builder` and Electron's `preload` loading work most reliably with
CommonJS (`require`, `__dirname`). The `package.json` does not declare
`"type": "module"`.

**4. `contextBridge` / `contextIsolation: true` / `nodeIntegration: false`**

Standard Electron security baseline. The preload script exposes a narrow
`window.electronAPI` surface to the renderer:
`getServerUrl`, `setServerUrl`, `deleteServerUrl`. The renderer cannot access
Node.js APIs directly.

**5. `sandbox: false` on `webPreferences`**

Required so the preload script can `require('electron')`. Safe in combination
with `contextIsolation: true`.

**6. `allowRunningInsecureContent: true`**

Allows HTTP pages to request media APIs once the origin is registered as a
secure context via the Chromium switch. Without this, Chromium may still block
mixed-content media requests.

**7. Navigation interception at two layers**

- `webContents.on('will-navigate')` — catches `window.location.href`
  assignments and form submits that navigate the current frame.
- `webContents.setWindowOpenHandler()` — catches `window.open()`,
  `<a target="_blank">` clicks, and middle-clicks. Returns `{ action: 'deny' }`
  to prevent a second `BrowserWindow` from opening; off-origin URLs are
  forwarded to `shell.openExternal()`.

Both layers are required for parity with the Tauri client's `on_navigation`
handler + JavaScript initialisation script pair.

**8. Setup UI by copy, not symlink**

`index.html` and `style.css` are copied verbatim from `client/ui/`. `setup.js`
is a parallel implementation using `window.electronAPI` instead of
`window.__TAURI__`. Symlinks are unreliable on Windows in git repositories.

**9. `--no-electron-client` build flag**

`scripts/build.ts` gains a `buildElectronClient()` step and a
`--no-electron-client` CLI flag. The existing `--no-client` flag continues to
skip only the Tauri build.

## Structure

```
electron/
  package.json          # electron, electron-builder, scripts, build config
  main.js               # main process: IPC, permission handler, window, menu
  preload.js            # contextBridge: exposes window.electronAPI
  ui/
    index.html          # setup form (copy of client/ui/index.html)
    style.css           # styles (copy of client/ui/style.css)
    setup.js            # adapted setup logic (window.electronAPI)
  icons/
    icon.png / .icns / .ico
```

## Consequences

- Microphone access works on plain HTTP server connections.
- Electron bundles Chromium (~100–200 MB) vs Tauri's native-webview approach
  (~4–8 MB). Users who do not need microphone may prefer the Tauri client.
- Each platform requires a native build host. CI needs separate macOS, Windows,
  and Linux runners for the Electron build.
- Changing the server URL triggers an app relaunch (~1 s latency). Acceptable
  for an infrequent operation.
- Root `package.json` gains `electron:dev` and `electron:build` scripts.
- `scripts/build.ts` gains `buildElectronClient()` and `--no-electron-client`.

## Alternatives Rejected

**HTTPS on the Bunny server.** Would require TLS certificate management on a
LAN host (self-signed cert UX, browser trust warnings). Out of scope for the
target audience.

**`webSecurity: false` on `BrowserWindow`.** Disables all origin checks
globally, which can break CORS-aware API responses. The
`unsafely-treat-insecure-origin-as-secure` per-origin switch is more surgical.

**Upgrading the Tauri client.** Tauri 2.x WKWebView and WebView2 honour the
browser secure-context rules and provide no equivalent per-origin bypass flag.

## Related

- ADR 0017 — Tauri v2 Desktop Client
- ADR 0041 — Diary subsystem (the subsystem requiring microphone access)
