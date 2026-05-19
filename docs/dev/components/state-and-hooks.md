# State and hooks

## At a glance

No Redux, no Zustand, no Recoil. State is either:

- **Local to a component** via `useState` / `useReducer`.
- **Shared across the app** via a custom hook (`useSSEChat`, `useNotifications`) that owns a subscription.
- **Persisted** via `localStorage` with a `bunny.*` prefix.
- **Server-owned** via `fetch` with `credentials: "include"`.

The boot-time `GET /api/auth/me` gate in `App.tsx` is the single authentication boundary; once past it, every fetch assumes the session cookie is present.

## Where the hooks live

- `web/src/hooks/useSSEChat.ts` — streams a chat turn, accumulates content/reasoning/tool_call/tool_result/ask-user into a `Turn` record.
- `web/src/hooks/useNotifications.ts` — maintains unread count, streams `notification_created` / `notification_read`, handles reconnect on visibility change.
- (Add new cross-cutting hooks here.)

## `localStorage` keys

All keys use the `bunny.` prefix so the namespace is searchable.

| Key | Owner | Notes |
| --- | --- | --- |
| `bunny.activeTab` | `App.tsx` | Current `NavTabId`. Aliased forward via `LEGACY_TAB_ALIAS`. |
| `bunny.activeProject` | `App.tsx` | Current project. Switching project starts a fresh session. |
| `bunny.activeSessionId` | `ChatTab` | Persists the open session across reloads. |
| `bunny.webNews.template` | `WebNewsTab` | `list` / `newspaper`. |
| `bunny.theme` | root | `light` / `dark`. Optional. |

Rules:

- Never write a key without the `bunny.` prefix.
- Keys are read-once on boot; subsequent state is in React.
- JSON values are OK but keep them small — localStorage quota is ~5 MB across the origin.

## `credentials: "include"` — everywhere

Every fetch includes `credentials: "include"` so the `bunny_session` cookie rides along. This is non-negotiable — without it, every call 401s.

```ts
const res = await fetch("/api/projects", {
  method: "GET",
  credentials: "include",
});
```

Wrap helpers live in `web/src/api.ts` — prefer them over raw `fetch`.

## Boot sequence

`App.tsx` on mount:

```
1. Read bunny.theme; apply [data-theme] to <html>.
2. GET /api/auth/me (credentials: include).
   - 401 → show <LoginPage>.
   - mustChangePassword → show <ChangePasswordPage>.
   - success → set user, read bunny.activeTab / activeProject / activeSessionId,
              parse deep link from window.location, mount <Sidebar> + tab.
3. Mount useNotifications (SSE subscription).
```

Subsequent boots follow the same path — cookie present → straight into the shell.

## Hook pattern

Custom hooks that own a subscription follow this shape:

```ts
export function useSomething(arg: Arg) {
  const [state, setState] = useState<State>(initial);

  useEffect(() => {
    const abort = new AbortController();
    (async () => {
      const res = await fetch("/api/…", { credentials: "include", signal: abort.signal });
      const reader = res.body!.getReader();
      // …accumulate into setState
    })();
    return () => abort.abort();
  }, [/* deps */]);

  return state;
}
```

Rules:

- Always use `AbortController` for cleanup.
- SSE subscriptions are `fetch` + body-reader (see `./streaming-ui.md`) — never `EventSource`.
- Reconnect on `visibilitychange` when relevant (notifications).

## Shared types

`web/src/api.ts` imports `SseEvent` from `src/agent/sse_events.ts` (cross-root via Vite's `server.fs.allow: [".."]`). Adding a new event type is a compile error on both sides.

Other shared types (auth user, theme, DTOs) live in `web/src/api.ts` — keep them explicit, no re-export gymnastics.

## Rules

- **Every fetch uses `credentials: "include"`.**
- **All localStorage keys start with `bunny.`.**
- **Subscriptions use `AbortController` for cleanup.**
- **No global state library.** If you feel one is justified, write a short proposal and discuss.
- **Legacy tab ids stay in `LEGACY_TAB_ALIAS`.** Never remove entries.

## Related

- [`./shell-and-navigation.md`](./shell-and-navigation.md) — where the boot gate lives.
- [`./streaming-ui.md`](./streaming-ui.md) — the SSE subscription pattern.
- [`../concepts/auth.md`](../concepts/auth.md) — the server side of the cookie.
