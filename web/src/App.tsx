import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  createSession,
  fetchMe,
  logout,
  setSessionQuickChat,
  type AuthUser,
  type OpenInChatPayload,
  type Theme,
} from "./api";
import LoginPage from "./pages/LoginPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import Sidebar, { type NavTabId } from "./components/Sidebar";
import ToastStack from "./components/ToastStack";
import { useNotifications } from "./hooks/useNotifications";

// Tabs + pages are route-level — lazy-load so the initial bundle stays small
// (mermaid, highlight.js, react-markdown, @dnd-kit end up in their own chunks).
const DashboardTab = lazy(() => import("./tabs/DashboardTab"));
const ChatTab = lazy(() => import("./tabs/ChatTab"));
const BoardTab = lazy(() => import("./tabs/BoardTab"));
const FilesTab = lazy(() => import("./tabs/FilesTab"));
const TasksTab = lazy(() => import("./tabs/TasksTab"));
const WhiteboardTab = lazy(() => import("./tabs/WhiteboardTab"));
const DocumentTab = lazy(() => import("./tabs/DocumentTab"));
const ContactsTab = lazy(() => import("./tabs/ContactsTab"));
const KnowledgeBaseTab = lazy(() => import("./tabs/KnowledgeBaseTab"));
const WebNewsTab = lazy(() => import("./tabs/WebNewsTab"));
const WorkspaceTab = lazy(() => import("./tabs/WorkspaceTab"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

type Tab = NavTabId;

const SESSION_STORAGE_KEY = "bunny.activeSessionId";
const PROJECT_STORAGE_KEY = "bunny.activeProject";
const TAB_STORAGE_KEY = "bunny.activeTab";
const THEME_STORAGE_KEY = "bunny.theme";
const DEFAULT_PROJECT = "general";

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

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// Apply the stored theme synchronously at module load so the first paint
// already matches. Without this, React mounts against the default dark
// palette and flashes to light on the subsequent effect tick.
if (typeof document !== "undefined") {
  applyTheme(resolveStoredTheme());
}

const VALID_TABS: ReadonlySet<string> = new Set<Tab>([
  "chat",
  "board",
  "tasks",
  "documents",
  "whiteboard",
  "files",
  "contacts",
  "knowledge-base",
  "news",
  "workspace",
  "dashboard",
  "settings",
]);

// Tabs that were removed in the 2026-04-17 redesign (ADR 0020) and where they
// now live. Keeps stored localStorage values usable after an upgrade.
const LEGACY_TAB_ALIAS: Record<string, Tab> = {
  messages: "chat",
  logs: "settings",
  projects: "workspace",
  agents: "workspace",
  skills: "workspace",
};
// For legacy aliases that land on Workspace, map to the matching inner sub-tab.
const LEGACY_WORKSPACE_SUB: Record<string, "projects" | "agents" | "skills"> = {
  projects: "projects",
  agents: "agents",
  skills: "skills",
};

// Tabs whose body is too dense for the rabbit watermark to sit behind it.
const DENSE_TABS: ReadonlySet<Tab> = new Set<Tab>(["dashboard"]);

function adoptSession(id: string): string {
  localStorage.setItem(SESSION_STORAGE_KEY, id);
  return id;
}

function adoptProject(name: string): string {
  localStorage.setItem(PROJECT_STORAGE_KEY, name);
  return name;
}

function resolveStoredTab(): Tab {
  const stored = localStorage.getItem(TAB_STORAGE_KEY);
  if (!stored) return "chat";
  if (VALID_TABS.has(stored)) return stored as Tab;
  const aliased = LEGACY_TAB_ALIAS[stored];
  if (aliased) return aliased;
  return "chat";
}

interface BootDeepLink {
  project?: string;
  session?: string;
  tab?: Tab;
}

function readBootDeepLink(): BootDeepLink | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session") ?? undefined;
  const project = params.get("project") ?? undefined;
  const tabParam = params.get("tab");
  const tab =
    tabParam && VALID_TABS.has(tabParam) ? (tabParam as Tab) : undefined;
  if (!session && !project && !tab) return null;
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch {
    /* ignore */
  }
  return { project, session, tab };
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [theme, setThemeRaw] = useState<Theme>(resolveStoredTheme);
  const setTheme = (t: Theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, t);
    applyTheme(t);
    setThemeRaw(t);
  };

  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_STORAGE_KEY)) return;
      const next: Theme = e.matches ? "light" : "dark";
      applyTheme(next);
      setThemeRaw(next);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    void fetchMe().then(setUser);
  }, []);

  if (user === undefined) return <div className="app-loading">Loading…</div>;
  if (user === null) return <LoginPage onLogin={setUser} />;
  if (user.mustChangePassword)
    return (
      <ChangePasswordPage
        user={user}
        onDone={() => setUser({ ...user, mustChangePassword: false })}
      />
    );

  return (
    <AuthenticatedShell
      user={user}
      setUser={setUser}
      theme={theme}
      setTheme={setTheme}
    />
  );
}

interface ShellProps {
  user: AuthUser;
  setUser: (u: AuthUser | null) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

function AuthenticatedShell({ user, setUser, theme, setTheme }: ShellProps) {
  const [tab, setTabRaw] = useState<Tab>(resolveStoredTab);
  const [initialWorkspaceSub] = useState<"projects" | "agents" | "skills">(
    () => {
      const stored = localStorage.getItem(TAB_STORAGE_KEY);
      return (stored && LEGACY_WORKSPACE_SUB[stored]) || "projects";
    },
  );
  const setTab = useCallback((t: Tab) => {
    localStorage.setItem(TAB_STORAGE_KEY, t);
    setTabRaw(t);
  }, []);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    localStorage.getItem(SESSION_STORAGE_KEY),
  );
  const [activeProject, setActiveProject] = useState<string>(
    () => localStorage.getItem(PROJECT_STORAGE_KEY) || DEFAULT_PROJECT,
  );
  const [pendingChatSend, setPendingChatSend] = useState<
    (OpenInChatPayload & { sessionId: string }) | null
  >(null);
  const onConsumePendingChatSend = useCallback(
    () => setPendingChatSend(null),
    [],
  );

  const [pendingDeepLink, setPendingDeepLink] = useState<BootDeepLink | null>(
    readBootDeepLink,
  );

  useEffect(() => {
    if (pendingDeepLink) {
      if (pendingDeepLink.project)
        setActiveProject(adoptProject(pendingDeepLink.project));
      if (pendingDeepLink.session)
        setSessionId(adoptSession(pendingDeepLink.session));
      if (pendingDeepLink.tab) setTab(pendingDeepLink.tab);
      setPendingDeepLink(null);
      return;
    }
    if (sessionId) return;
    void (async () => {
      try {
        setSessionId(adoptSession(await createSession()));
      } catch {
        /* ignored */
      }
    })();
  }, [sessionId, pendingDeepLink, setTab]);

  const notifications = useNotifications({
    activeSessionId: tab === "chat" ? sessionId : null,
  });

  const navigateDeepLink = useCallback(
    (link: string) => {
      let u: URL;
      try {
        u = new URL(link, window.location.origin);
      } catch {
        return;
      }
      const nextProject = u.searchParams.get("project");
      const nextSession = u.searchParams.get("session");
      const nextTab = u.searchParams.get("tab");
      if (nextProject) setActiveProject(adoptProject(nextProject));
      if (nextSession) setSessionId(adoptSession(nextSession));
      if (nextTab && VALID_TABS.has(nextTab)) setTab(nextTab as Tab);
    },
    [setTab],
  );

  const onNewSession = async () => {
    setSessionId(adoptSession(await createSession()));
  };

  const onNewQuickChat = async () => {
    const id = await createSession();
    try {
      await setSessionQuickChat(id, true);
    } catch (e) {
      console.error(e);
    }
    setSessionId(adoptSession(id));
  };

  const onPickSession = (id: string) => {
    setSessionId(adoptSession(id));
  };

  const onOpenInChat = (sid: string, payload?: OpenInChatPayload) => {
    if (payload?.prompt) setPendingChatSend({ sessionId: sid, ...payload });
    onPickSession(sid);
    setTab("chat");
  };

  const onPickProject = async (name: string) => {
    setActiveProject(adoptProject(name));
    try {
      setSessionId(adoptSession(await createSession()));
    } catch {
      /* ignored */
    }
    setTab("dashboard");
  };

  const onLogout = async () => {
    await logout();
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(PROJECT_STORAGE_KEY);
    setSessionId(null);
    setActiveProject(DEFAULT_PROJECT);
    setUser(null);
  };

  const dense = DENSE_TABS.has(tab);

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={tab}
        onPickTab={setTab}
        user={user}
        activeProject={activeProject}
        onPickProjectTab={() => setTab("workspace")}
        onLogout={onLogout}
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        notifications={{
          items: notifications.items,
          unreadCount: notifications.unreadCount,
          hasMore: notifications.hasMore,
          onMarkRead: notifications.markRead,
          onMarkAllRead: notifications.markAllRead,
          onDismiss: notifications.dismiss,
          onLoadMore: notifications.loadMore,
          onRequestPermission: notifications.requestOSPermission,
          onNavigate: navigateDeepLink,
        }}
      />

      <main
        className={`app-shell__main ${dense ? "app-shell__main--dense" : ""}`}
        data-tab={tab}
      >
        <Suspense fallback={<div className="app-loading">Loading…</div>}>
          {tab === "dashboard" && <DashboardTab currentUser={user} />}
          {tab === "chat" && sessionId && (
            <ChatTab
              sessionId={sessionId}
              project={activeProject}
              currentUser={user}
              onPickSession={onPickSession}
              onNewSession={onNewSession}
              onNewQuickChat={onNewQuickChat}
              pendingChatSend={pendingChatSend}
              onConsumePendingChatSend={onConsumePendingChatSend}
            />
          )}
          {tab === "board" && (
            <BoardTab
              project={activeProject}
              currentUser={user}
              onOpenInChat={(sid) => onOpenInChat(sid)}
            />
          )}
          {tab === "workspace" && (
            <WorkspaceTab
              currentUser={user}
              activeProject={activeProject}
              onPickProject={onPickProject}
              initialSub={initialWorkspaceSub}
            />
          )}
          {tab === "whiteboard" && (
            <WhiteboardTab project={activeProject} onOpenInChat={onOpenInChat} />
          )}
          {tab === "documents" && (
            <DocumentTab
              project={activeProject}
              currentUser={user}
              onOpenInChat={onOpenInChat}
            />
          )}
          {tab === "contacts" && (
            <ContactsTab
              project={activeProject}
              currentUser={user}
              onOpenInChat={onOpenInChat}
            />
          )}
          {tab === "knowledge-base" && (
            <KnowledgeBaseTab project={activeProject} currentUser={user} />
          )}
          {tab === "news" && (
            <WebNewsTab project={activeProject} currentUser={user} />
          )}
          {tab === "files" && (
            <FilesTab project={activeProject} currentUser={user} />
          )}
          {tab === "tasks" && <TasksTab currentUser={user} />}
          {tab === "settings" && (
            <SettingsPage user={user} onUserUpdated={(u) => setUser(u)} />
          )}
        </Suspense>
      </main>

      <ToastStack
        toasts={notifications.toasts}
        onDismiss={notifications.clearToast}
        onClickToast={navigateDeepLink}
      />
    </div>
  );
}
