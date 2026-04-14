import { useEffect, useState } from "react";
import { createSession, fetchMe, logout, type AuthUser } from "./api";
import ChatTab from "./tabs/ChatTab";
import MessagesTab from "./tabs/MessagesTab";
import LoginPage from "./pages/LoginPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import SettingsPage from "./pages/SettingsPage";

type Tab = "chat" | "messages" | "settings";

const SESSION_STORAGE_KEY = "bunny.activeSessionId";

function adoptSession(id: string): string {
  localStorage.setItem(SESSION_STORAGE_KEY, id);
  return id;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [sessionId, setSessionId] = useState<string | null>(() =>
    localStorage.getItem(SESSION_STORAGE_KEY),
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

  const onLogout = async () => {
    await logout();
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSessionId(null);
    setUser(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span>bunny</span>
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
            onPickSession={onPickSession}
            onNewSession={onNewSession}
          />
        )}
        {tab === "messages" && <MessagesTab currentUser={user} />}
        {tab === "settings" && <SettingsPage user={user} onUserUpdated={setUser} />}
      </main>
    </div>
  );
}
