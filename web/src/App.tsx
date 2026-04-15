import { useEffect, useState } from "react";
import { createSession, fetchMe, logout, type AuthUser } from "./api";
import ChatTab from "./tabs/ChatTab";
import MessagesTab from "./tabs/MessagesTab";
import ProjectsTab from "./tabs/ProjectsTab";
import AgentsTab from "./tabs/AgentsTab";
import BoardTab from "./tabs/BoardTab";
import FilesTab from "./tabs/FilesTab";
import LogsTab from "./tabs/LogsTab";
import TasksTab from "./tabs/TasksTab";
import LoginPage from "./pages/LoginPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import SettingsPage from "./pages/SettingsPage";

type Tab = "chat" | "messages" | "board" | "files" | "tasks" | "projects" | "agents" | "logs" | "settings";

const SESSION_STORAGE_KEY = "bunny.activeSessionId";
const PROJECT_STORAGE_KEY = "bunny.activeProject";
const DEFAULT_PROJECT = "general";

function adoptSession(id: string): string {
  localStorage.setItem(SESSION_STORAGE_KEY, id);
  return id;
}

function adoptProject(name: string): string {
  localStorage.setItem(PROJECT_STORAGE_KEY, name);
  return name;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
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
    setTab("chat");
  };

  const onLogout = async () => {
    await logout();
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(PROJECT_STORAGE_KEY);
    setSessionId(null);
    setActiveProject(DEFAULT_PROJECT);
    setUser(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span>bunny</span>
          <span className="project-pill" title="Active project">
            {activeProject}
          </span>
        </div>
        <nav className="tabs">
          <button
            className={`tab ${tab === "chat" ? "tab--active" : ""}`}
            onClick={() => setTab("chat")}
          >
            Chat
          </button>
          <button
            className={`tab ${tab === "messages" ? "tab--active" : ""}`}
            onClick={() => setTab("messages")}
          >
            Messages
          </button>
          <button
            className={`tab ${tab === "board" ? "tab--active" : ""}`}
            onClick={() => setTab("board")}
          >
            Board
          </button>
          <button
            className={`tab ${tab === "files" ? "tab--active" : ""}`}
            onClick={() => setTab("files")}
          >
            Files
          </button>
          <button
            className={`tab ${tab === "tasks" ? "tab--active" : ""}`}
            onClick={() => setTab("tasks")}
          >
            Tasks
          </button>
          <button
            className={`tab ${tab === "projects" ? "tab--active" : ""}`}
            onClick={() => setTab("projects")}
          >
            Projects
          </button>
          <button
            className={`tab ${tab === "agents" ? "tab--active" : ""}`}
            onClick={() => setTab("agents")}
          >
            Agents
          </button>
          {user.role === "admin" && (
            <button
              className={`tab ${tab === "logs" ? "tab--active" : ""}`}
              onClick={() => setTab("logs")}
            >
              Logs
            </button>
          )}
          <button
            className={`tab ${tab === "settings" ? "tab--active" : ""}`}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
        </nav>
        <div className="topbar-right">
          <span className="user-chip" title={user.email ?? ""}>
            {user.displayName || user.username}
            <span className="user-role">{user.role}</span>
          </span>
          <button className="logout-btn" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <main className="main">
        {tab === "chat" && sessionId && (
          <ChatTab
            sessionId={sessionId}
            project={activeProject}
            onPickSession={onPickSession}
            onNewSession={onNewSession}
          />
        )}
        {tab === "messages" && <MessagesTab currentUser={user} project={activeProject} />}
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
        {tab === "projects" && (
          <ProjectsTab currentUser={user} activeProject={activeProject} onPickProject={onPickProject} />
        )}
        {tab === "agents" && <AgentsTab currentUser={user} activeProject={activeProject} />}
        {tab === "files" && <FilesTab project={activeProject} currentUser={user} />}
        {tab === "tasks" && <TasksTab currentUser={user} />}
        {tab === "logs" && user.role === "admin" && <LogsTab />}
        {tab === "settings" && <SettingsPage user={user} onUserUpdated={setUser} />}
      </main>
    </div>
  );
}
