import { useEffect, useState } from "react";
import { createSession } from "./api";
import ChatTab from "./tabs/ChatTab";
import MessagesTab from "./tabs/MessagesTab";

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

  useEffect(() => {
    if (sessionId) return;
    void (async () => {
      setSessionId(adoptSession(await createSession()));
    })();
  }, [sessionId]);

  const onNewSession = async () => {
    setSessionId(adoptSession(await createSession()));
  };

  const onPickSession = (id: string) => {
    setSessionId(adoptSession(id));
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
        <div className="topbar-right" />
      </header>

      <main className="main">
        {tab === "chat" && sessionId && (
          <ChatTab
            sessionId={sessionId}
            onPickSession={onPickSession}
            onNewSession={onNewSession}
          />
        )}
        {tab === "messages" && <MessagesTab />}
      </main>
    </div>
  );
}
