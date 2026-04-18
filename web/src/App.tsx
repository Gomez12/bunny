import { lazy, Suspense, useEffect, useState } from "react";
import { createSession, fetchMe, logout, type AuthUser } from "./api";
import LoginPage from "./pages/LoginPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import Sidebar, { type NavTabId } from "./components/Sidebar";

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
const WorkspaceTab = lazy(() => import("./tabs/WorkspaceTab"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

type Tab = NavTabId;

const SESSION_STORAGE_KEY = "bunny.activeSessionId";
const PROJECT_STORAGE_KEY = "bunny.activeProject";
const TAB_STORAGE_KEY = "bunny.activeTab";
const DEFAULT_PROJECT = "general";

const VALID_TABS: ReadonlySet<string> = new Set<Tab>([
  "chat",
  "board",
  "tasks",
  "documents",
  "whiteboard",
  "files",
  "contacts",
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

export default function App() {
  const [tab, setTabRaw] = useState<Tab>(resolveStoredTab);
  // Pick the initial Workspace sub-tab from legacy storage on first paint only.
  const [initialWorkspaceSub] = useState<"projects" | "agents" | "skills">(() => {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return (stored && LEGACY_WORKSPACE_SUB[stored]) || "projects";
  });
  const setTab = (t: Tab) => {
    localStorage.setItem(TAB_STORAGE_KEY, t);
    setTabRaw(t);
  };
  const [sessionId, setSessionId] = useState<string | null>(() =>
    localStorage.getItem(SESSION_STORAGE_KEY),
  );
  const [activeProject, setActiveProject] = useState<string>(
    () => localStorage.getItem(PROJECT_STORAGE_KEY) || DEFAULT_PROJECT,
  );
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    void fetchMe().then(setUser);
  }, []);

  const pwChangeRequired = !!user && user.mustChangePassword;

  useEffect(() => {
    if (!user || pwChangeRequired) return;
    if (sessionId) return;
    void (async () => {
      try {
        setSessionId(adoptSession(await createSession()));
      } catch {
        // ignored — user likely not yet authenticated
      }
    })();
  }, [user, pwChangeRequired, sessionId]);

  if (user === undefined) return <div className="app-loading">Loading…</div>;

  if (user === null) return <LoginPage onLogin={setUser} />;

  if (pwChangeRequired) {
    return (
      <ChangePasswordPage
        user={user}
        onDone={() => setUser({ ...user, mustChangePassword: false })}
      />
    );
  }

  const onNewSession = async () => {
    setSessionId(adoptSession(await createSession()));
  };

  const onPickSession = (id: string) => {
    setSessionId(adoptSession(id));
  };

  const onPickProject = async (name: string) => {
    setActiveProject(adoptProject(name));
    // Switching project always starts a fresh session (one project per session).
    try {
      setSessionId(adoptSession(await createSession()));
    } catch {
      // ignored — error surfaces on next API call
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
            />
          )}
          {tab === "board" && (
            <BoardTab
              project={activeProject}
              currentUser={user}
              onOpenInChat={(sid) => {
                onPickSession(sid);
                setTab("chat");
              }}
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
            <WhiteboardTab
              project={activeProject}
              onOpenInChat={(sid) => {
                onPickSession(sid);
                setTab("chat");
              }}
            />
          )}
          {tab === "documents" && (
            <DocumentTab
              project={activeProject}
              onOpenInChat={(sid) => {
                onPickSession(sid);
                setTab("chat");
              }}
            />
          )}
          {tab === "contacts" && (
            <ContactsTab
              project={activeProject}
              currentUser={user}
              onOpenInChat={(sid) => {
                onPickSession(sid);
                setTab("chat");
              }}
            />
          )}
          {tab === "files" && <FilesTab project={activeProject} currentUser={user} />}
          {tab === "tasks" && <TasksTab currentUser={user} />}
          {tab === "settings" && <SettingsPage user={user} onUserUpdated={setUser} />}
        </Suspense>
      </main>
    </div>
  );
}
