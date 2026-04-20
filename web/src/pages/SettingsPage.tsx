import { lazy, Suspense, useEffect, useState } from "react";
import type { AuthUser } from "../api";
import { updateOwnProfile, changeOwnPassword } from "../api";
import ApiKeyList from "../components/ApiKeyList";
import UserList from "../components/UserList";
import TelegramLinkCard from "../components/TelegramLinkCard";

const LogsTab = lazy(() => import("../tabs/LogsTab"));
const TrashTab = lazy(() => import("../tabs/TrashTab"));
const PromptsAdminTab = lazy(() => import("../tabs/PromptsAdminTab"));

type Tab = "profile" | "keys" | "users" | "prompts" | "trash" | "logs";

export default function SettingsPage({
  user,
  onUserUpdated,
}: {
  user: AuthUser;
  onUserUpdated: (u: AuthUser) => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");

  return (
    <div className="settings">
      <nav className="settings-nav">
        <button
          className={tab === "profile" ? "active" : ""}
          onClick={() => setTab("profile")}
        >
          Profile
        </button>
        <button className={tab === "keys" ? "active" : ""} onClick={() => setTab("keys")}>
          API keys
        </button>
        {user.role === "admin" && (
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            Users
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>
            Prompts
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "trash" ? "active" : ""} onClick={() => setTab("trash")}>
            Trash
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
            Logs
          </button>
        )}
      </nav>
      <section className="settings-body">
        {tab === "profile" && <ProfileForm user={user} onUpdated={onUserUpdated} />}
        {tab === "keys" && <ApiKeyList />}
        {tab === "users" && user.role === "admin" && <UserList currentUserId={user.id} />}
        {tab === "prompts" && user.role === "admin" && (
          <Suspense fallback={<div className="app-loading">Loading…</div>}>
            <PromptsAdminTab />
          </Suspense>
        )}
        {tab === "trash" && user.role === "admin" && (
          <Suspense fallback={<div className="app-loading">Loading…</div>}>
            <TrashTab />
          </Suspense>
        )}
        {tab === "logs" && user.role === "admin" && (
          <Suspense fallback={<div className="app-loading">Loading…</div>}>
            <LogsTab />
          </Suspense>
        )}
      </section>
    </div>
  );
}

const LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "nl", name: "Nederlands" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "sv", name: "Svenska" },
  { code: "no", name: "Norsk" },
  { code: "da", name: "Dansk" },
  { code: "pl", name: "Polski" },
  { code: "fi", name: "Suomi" },
  { code: "tr", name: "Türkçe" },
  { code: "ja", name: "日本語" },
  { code: "zh", name: "中文" },
  { code: "ko", name: "한국어" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
];

function ProfileForm({ user, onUpdated }: { user: AuthUser; onUpdated: (u: AuthUser) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [expandThink, setExpandThink] = useState(user.expandThinkBubbles);
  const [expandTool, setExpandTool] = useState(user.expandToolBubbles);
  const [preferredLang, setPreferredLang] = useState<string>(user.preferredLanguage ?? "");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user.displayName ?? "");
    setEmail(user.email ?? "");
    setExpandThink(user.expandThinkBubbles);
    setExpandTool(user.expandToolBubbles);
    setPreferredLang(user.preferredLanguage ?? "");
  }, [user]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      const u = await updateOwnProfile({
        displayName: displayName || null,
        email: email || null,
        expandThinkBubbles: expandThink,
        expandToolBubbles: expandTool,
        preferredLanguage: preferredLang || null,
      });
      onUpdated(u);
      setMsg("Profile saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  };

  const submitPw = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      await changeOwnPassword(currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setMsg("Password updated.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change password");
    }
  };

  return (
    <div className="profile">
      <form onSubmit={save}>
        <h2>Profile</h2>
        <div className="read-only">
          <div>
            <span className="muted">Username</span>
            <span>{user.username}</span>
          </div>
          <div>
            <span className="muted">Role</span>
            <span>{user.role}</span>
          </div>
        </div>
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          <span>Preferred language</span>
          <select
            value={preferredLang}
            onChange={(e) => setPreferredLang(e.target.value)}
          >
            <option value="">Follow project default</option>
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.code.toUpperCase()} · {opt.name}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            Determines the language you author new entities in and the first
            tab shown when you open existing entities. If a project doesn't
            support this language, we use that project's default.
          </span>
        </label>
        <h3>Chat display</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={expandThink}
            onChange={(e) => setExpandThink(e.target.checked)}
          />
          <span>Expand think bubbles by default</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={expandTool}
            onChange={(e) => setExpandTool(e.target.checked)}
          />
          <span>Expand tool bubbles by default</span>
        </label>
        <button type="submit">Save profile</button>
      </form>

      <form onSubmit={submitPw}>
        <h2>Password</h2>
        <label>
          <span>Current password</span>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            required
          />
        </label>
        <label>
          <span>New password</span>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            required
          />
        </label>
        <button type="submit">Change password</button>
      </form>

      {msg && <div className="auth-ok">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}

      <TelegramLinkCard />
    </div>
  );
}
