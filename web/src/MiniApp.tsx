import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  createSession,
  fetchMeInfo,
  setSessionQuickChat,
  type AuthUser,
} from "./api";
import { DefaultAgentProvider } from "./contexts/DefaultAgentContext";
import { loadActiveAgent, saveActiveAgent } from "./lib/activeAgent";
import LoginPage from "./pages/LoginPage";

const ChatTab = lazy(() => import("./tabs/ChatTab"));

const MINI_SESSION_KEY_PREFIX = "bunny.miniSessionId.";
const PROJECT_STORAGE_KEY = "bunny.activeProject";
const THEME_STORAGE_KEY = "bunny.theme";
const DEFAULT_PROJECT = "general";

function miniSessionKey(project: string): string {
  return `${MINI_SESSION_KEY_PREFIX}${project}`;
}

type Theme = "light" | "dark";

function resolveStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return "dark";
}

if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = resolveStoredTheme();
}

interface ElectronBridge {
  isMiniWindow?: () => boolean;
  openMainWindow?: (opts?: { sessionId?: string }) => Promise<void>;
  closeMiniWindow?: () => Promise<void>;
}

function getElectronAPI(): ElectronBridge | null {
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI ?? null;
}

export default function MiniApp() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [defaultAgent, setDefaultAgent] = useState<string>("bunny");

  useEffect(() => {
    void fetchMeInfo().then((me) => {
      if (!me) {
        setUser(null);
        return;
      }
      setUser(me.user);
      setDefaultAgent(me.defaultAgent || "bunny");
    });
  }, []);

  if (user === undefined)
    return <div className="app-loading">Loading…</div>;
  if (user === null) {
    // Login flow drives a real auth cookie; once set, the next render walks
    // through the authenticated path.
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <DefaultAgentProvider value={defaultAgent}>
      <MiniShell user={user} defaultAgent={defaultAgent} />
    </DefaultAgentProvider>
  );
}

interface ShellProps {
  user: AuthUser;
  defaultAgent: string;
}

function MiniShell({ user, defaultAgent }: ShellProps) {
  // Project precedence for Quick Chat:
  //   1. user.uiPrefs.defaultQuickChatProject  (set in Settings)
  //   2. last-used project in the main app (localStorage)
  //   3. "general"
  const [project] = useState<string>(
    () =>
      user.uiPrefs?.defaultQuickChatProject ||
      localStorage.getItem(PROJECT_STORAGE_KEY) ||
      DEFAULT_PROJECT,
  );
  // The mini-window remembers one session per project so changing the default
  // doesn't reuse a session bound to a different project (sessions are
  // immutable to one project — see ADR 0008).
  const [sessionId, setSessionId] = useState<string | null>(() =>
    localStorage.getItem(miniSessionKey(project)),
  );
  const [activeAgent, setActiveAgent] = useState<string>(() =>
    sessionId ? loadActiveAgent(sessionId, defaultAgent) : defaultAgent,
  );

  // Mint a brand-new Quick Chat session when the mini-window has none.
  useEffect(() => {
    if (sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const id = await createSession();
        if (cancelled) return;
        try {
          await setSessionQuickChat(id, true);
        } catch (e) {
          console.warn("[mini] could not mark Quick Chat", e);
        }
        localStorage.setItem(miniSessionKey(project), id);
        setSessionId(id);
      } catch (e) {
        console.error("[mini] createSession failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, project]);

  useEffect(() => {
    if (!sessionId) return;
    setActiveAgent(loadActiveAgent(sessionId, defaultAgent));
  }, [sessionId, defaultAgent]);

  const onChangeActiveAgent = useCallback(
    (name: string) => {
      setActiveAgent(name);
      if (sessionId) saveActiveAgent(sessionId, name);
    },
    [sessionId],
  );

  const onPickSession = useCallback(
    (id: string) => {
      localStorage.setItem(miniSessionKey(project), id);
      setSessionId(id);
    },
    [project],
  );

  const onNewSession = useCallback(async () => {
    try {
      const id = await createSession();
      try {
        await setSessionQuickChat(id, true);
      } catch (e) {
        console.warn("[mini] could not mark Quick Chat", e);
      }
      localStorage.setItem(miniSessionKey(project), id);
      setSessionId(id);
    } catch (e) {
      console.error("[mini] new session failed", e);
    }
  }, [project]);

  const onExpand = useCallback(() => {
    const api = getElectronAPI();
    if (api?.openMainWindow && sessionId) {
      void api.openMainWindow({ sessionId });
      return;
    }
    if (sessionId) {
      // Web fallback: open the same server in a new tab pointed at the session.
      const url = new URL(window.location.href);
      url.searchParams.delete("mini");
      url.searchParams.set("session", sessionId);
      window.open(url.toString(), "_blank", "noopener");
    }
  }, [sessionId]);

  const onHide = useCallback(() => {
    const api = getElectronAPI();
    if (api?.closeMiniWindow) {
      void api.closeMiniWindow();
    } else {
      window.close();
    }
  }, []);

  if (!sessionId) {
    return <div className="app-loading">Starting Quick Chat…</div>;
  }

  return (
    <div className="mini-shell">
      <header className="mini-shell__header">
        <span className="mini-shell__title">
          <span className="mini-shell__dot" /> Quick Chat
        </span>
        <span className="mini-shell__actions">
          <button
            type="button"
            className="mini-shell__btn"
            onClick={onNewSession}
            title="Start a new Quick Chat"
          >
            New
          </button>
          <button
            type="button"
            className="mini-shell__btn"
            onClick={onExpand}
            title="Open this session in the full Bunny window"
          >
            Expand
          </button>
          <button
            type="button"
            className="mini-shell__btn mini-shell__btn--ghost"
            onClick={onHide}
            title="Hide the Quick Chat window"
          >
            Hide
          </button>
        </span>
      </header>
      <div className="mini-shell__body">
        <Suspense
          fallback={<div className="app-loading">Loading chat…</div>}
        >
          <ChatTab
            compact
            autoFocusComposer
            sessionId={sessionId}
            project={project}
            currentUser={user}
            activeAgent={activeAgent}
            defaultAgent={defaultAgent}
            onChangeActiveAgent={onChangeActiveAgent}
            onPickSession={onPickSession}
            onNewSession={onNewSession}
          />
        </Suspense>
      </div>
    </div>
  );
}
