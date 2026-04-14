import { useEffect, useState } from "react";
import { createSession, fetchSessions, type SessionSummary } from "./api";
import ChatTab from "./tabs/ChatTab";
import MessagesTab from "./tabs/MessagesTab";
import SessionPicker from "./components/SessionPicker";

type Tab = "chat" | "messages";

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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  const reloadSessions = () => {
    fetchSessions()
      .then(setSessions)
      .catch((e) => console.error(e));
  };

  useEffect(() => {
    if (sessionId) return;
    void (async () => {
      setSessionId(adoptSession(await createSession()));
    })();
  }, [sessionId]);

  useEffect(reloadSessions, []);

  const onNewSession = async () => {
    setSessionId(adoptSession(await createSession()));
    // Don't refetch: a fresh session has no messages and won't appear in
    // listSessions() until the first turn completes.
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
        </nav>
        <div className="topbar-right">
          {tab === "chat" && sessionId && (
            <SessionPicker
              sessions={sessions}
              activeId={sessionId}
              onPick={(id) => setSessionId(adoptSession(id))}
              onNew={onNewSession}
            />
          )}
        </div>
      </header>

      <main className="main">
        {tab === "chat" && sessionId && (
          <ChatTab sessionId={sessionId} onTurnComplete={reloadSessions} />
        )}
        {tab === "messages" && <MessagesTab />}
      </main>
    </div>
  );
}
