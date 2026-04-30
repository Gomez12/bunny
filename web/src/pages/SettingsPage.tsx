import { lazy, Suspense, useEffect, useState } from "react";
import type { AuthUser, SoulInfo } from "../api";
import {
  updateOwnProfile,
  changeOwnPassword,
  fetchOwnSoul,
  updateOwnSoul,
} from "../api";
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

      <SoulForm />

      <TelegramLinkCard />
    </div>
  );
}

function SoulForm() {
  const [info, setInfo] = useState<SoulInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOwnSoul()
      .then((s) => {
        if (cancelled) return;
        setInfo(s);
        setDraft(s.soul);
      })
      .catch((e) =>
        setErr(e instanceof Error ? e.message : "Could not load soul"),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      const next = await updateOwnSoul(draft);
      setInfo(next);
      setDraft(next.soul);
      setMsg("Soul saved.");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const cap = info?.maxChars ?? 4000;
  const formatted =
    info?.refreshedAt != null
      ? new Date(info.refreshedAt).toLocaleString()
      : "never";

  return (
    <form onSubmit={save}>
      <h2>Personal style & background (soul)</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
        A short personality + style profile spliced into every chat's system
        prompt so assistants speak in the register you prefer. Auto-curated
        hourly from your messages; edit freely — your text is the seed for the
        next refresh.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, cap))}
        rows={10}
        style={{ width: "100%", fontFamily: "inherit", fontSize: 14 }}
        placeholder="e.g. I prefer terse answers in Dutch, keep responses under 3 paragraphs, I'm a backend engineer and use Bun…"
      />
      <div
        className="muted"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
        }}
      >
        <span>
          {draft.length} / {cap}
        </span>
        <span>
          Status: {info?.status ?? "?"} · last refreshed: {formatted}
        </span>
      </div>
      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save soul"}
      </button>
      {msg && <div className="auth-ok">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}
    </form>
  );
}
