# ADR 0017 — Tauri v2 Desktop Client

## Status

Accepted

## Context

Bunny already ships a self-contained server binary with an embedded web UI. Users who want a native desktop experience (e.g. dock icon, system tray, keyboard shortcuts) currently have to open a browser tab. A lightweight native wrapper would improve the experience without duplicating server logic.

## Decision

Add a Tauri v2 desktop client under `client/` at the project root. The client is a pure wrapper — it does **not** embed the server. On first launch it shows a local setup page where the user enters the server URL. The URL is persisted via the `tauri-plugin-store` plugin. Subsequent launches navigate directly to the saved server address.

### Key choices

1. **Tauri v2** over Electron: smaller binary, lower memory footprint, uses the system webview.
2. **Separate `client/` directory**: self-contained with its own `package.json` and `src-tauri/`. No coupling to the server build pipeline.
3. **No bundler for the setup page**: three static files (`index.html`, `setup.js`, `style.css`) loaded via `withGlobalTauri: true` — avoids adding Vite/webpack to the client.
4. **`tauri-plugin-store`** for persistence: handles OS-appropriate app data paths automatically.
5. **Menu-based reset**: "File → Reset Connection" clears the stored URL and returns to the setup page.

## Structure

```
client/
  package.json
  ui/
    index.html, setup.js, style.css
  src-tauri/
    Cargo.toml, tauri.conf.json, build.rs
    capabilities/default.json
    src/main.rs, src/lib.rs
```

## Consequences

- Each target platform must be built natively (no Tauri cross-compilation). CI needs macOS, Linux, and Windows runners for client builds.
- The server binary build (`bun run build`) is completely unaffected.
- `client/src-tauri/target/` is added to `.gitignore` (Rust build output).
- Root `package.json` gains `client:dev` and `client:build` convenience scripts.
