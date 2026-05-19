import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type {
  AuthUser,
  CalendarException,
  ScriptRuntimes,
  SoulInfo,
} from "../api";
import {
  updateOwnProfile,
  changeOwnPassword,
  fetchOwnSoul,
  updateOwnSoul,
  fetchScriptRuntimes,
  patchScriptRuntimes,
  createGlobalCalendarException,
  deleteCalendarException,
  listGlobalCalendarExceptions,
  patchCalendarException,
  listUserCalendarExceptions,
  createUserCalendarException,
  markWeekendsAsNonWorking,
  streamFetchHolidays,
  fetchProjects,
  updateGlobalUiPrefs,
  type Project,
} from "../api";
import ApiKeyList from "../components/ApiKeyList";
import UserList from "../components/UserList";
import TelegramLinkCard from "../components/TelegramLinkCard";
import CalendarExceptionEditor from "../components/CalendarExceptionEditor";

const LogsTab = lazy(() => import("../tabs/LogsTab"));
const TrashTab = lazy(() => import("../tabs/TrashTab"));
const PromptsAdminTab = lazy(() => import("../tabs/PromptsAdminTab"));
const FeedPatternsAdmin = lazy(() => import("../tabs/FeedPatternsAdmin"));

type Tab = "profile" | "keys" | "users" | "prompts" | "trash" | "logs" | "runtimes" | "feed_patterns" | "calendar";

const WIDE_TABS: ReadonlySet<Tab> = new Set<Tab>([
  "users",
  "prompts",
  "trash",
  "logs",
]);

export default function SettingsPage({
  user,
  onUserUpdated,
  initialSub,
  initialLogsErrorsOnly = false,
}: {
  user: AuthUser;
  onUserUpdated: (u: AuthUser) => void;
  initialSub?: "logs";
  initialLogsErrorsOnly?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(
    initialSub && user.role === "admin" ? initialSub : "profile",
  );

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
        {user.role === "admin" && (
          <button className={tab === "runtimes" ? "active" : ""} onClick={() => setTab("runtimes")}>
            Script Runtimes
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "feed_patterns" ? "active" : ""} onClick={() => setTab("feed_patterns")}>
            Feed Patterns
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "calendar" ? "active" : ""} onClick={() => setTab("calendar")}>
            Calendar
          </button>
        )}
      </nav>
      <section
        className={`settings-body${
          WIDE_TABS.has(tab) ? " settings-body--wide" : ""
        }`}
      >
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
            <LogsTab initialErrorsOnly={initialLogsErrorsOnly} />
          </Suspense>
        )}
        {tab === "runtimes" && user.role === "admin" && (
          <ScriptRuntimesForm />
        )}
        {tab === "feed_patterns" && user.role === "admin" && (
          <Suspense fallback={<div className="app-loading">Loading…</div>}>
            <FeedPatternsAdmin />
          </Suspense>
        )}
        {tab === "calendar" && user.role === "admin" && (
          <GlobalCalendarSection />
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
  const [defaultQcProject, setDefaultQcProject] = useState<string>(
    user.uiPrefs?.defaultQuickChatProject ?? "",
  );
  const [projects, setProjects] = useState<Project[]>([]);
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
    setDefaultQcProject(user.uiPrefs?.defaultQuickChatProject ?? "");
  }, [user]);

  // Load the user's accessible projects once so the Quick-Chat-default
  // dropdown can offer them. The endpoint is already filtered by visibility.
  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((list) => !cancelled && setProjects(list))
      .catch(() => !cancelled && setProjects([]));
    return () => {
      cancelled = true;
    };
  }, []);

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
      // Persist the Quick-Chat default through the uiPrefs endpoint and merge
      // the result onto the user the parent holds, so a remount renders the
      // saved value without a fresh /auth/me round-trip.
      const nextPrefs = await updateGlobalUiPrefs({
        defaultQuickChatProject: defaultQcProject || null,
      });
      onUpdated({ ...u, uiPrefs: { ...(u.uiPrefs ?? {}), ...nextPrefs } });
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
        <label>
          <span>Default Quick Chat project</span>
          <select
            value={defaultQcProject}
            onChange={(e) => setDefaultQcProject(e.target.value)}
          >
            <option value="">(none — use the active project)</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            Project (and its agents) used when the Electron tray spawns a
            Quick Chat. Leave empty to fall back to whichever project is
            active in the main window.
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

      <UserCalendarSection />

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

// ── Script Runtimes Admin Form ────────────────────────────────────────────────

const RUNTIME_ROWS: {
  field: keyof ScriptRuntimes;
  label: string;
  help: string;
}[] = [
  {
    field: "dotnetPath",
    label: "dotnet",
    help: "Path to the dotnet executable. .NET 10+ supports file-based run. Empty = C# execution disabled.",
  },
  {
    field: "pythonPath",
    label: "python",
    help: "Path to the python executable. Empty = Python execution disabled.",
  },
  {
    field: "powershellPath",
    label: "pwsh",
    help: "Path to PowerShell (pwsh). Empty = defaults to 'pwsh' on PATH.",
  },
  {
    field: "goPath",
    label: "go",
    help: "Path to the Go executable. Empty = defaults to 'go' on PATH.",
  },
  {
    field: "bunPath",
    label: "bun (override)",
    help: "Override the Bun executable path. Empty = uses the current Bun process (always available).",
  },
];

function ScriptRuntimesForm() {
  const [runtimes, setRuntimes] = useState<ScriptRuntimes | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchScriptRuntimes()
      .then(setRuntimes)
      .catch(() => setErr("Failed to load runtime config"));
  }, []);

  if (!runtimes) return <div className="loading-state">Loading…</div>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      await patchScriptRuntimes(runtimes!);
      setMsg("Saved.");
    } catch {
      setErr("Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="profile" onSubmit={handleSubmit}>
      <h2>Script Runtimes</h2>
      <p className="muted" style={{ marginBottom: "16px" }}>
        Configure executable paths for script execution. Bun/JavaScript always
        works without configuration. See{" "}
        <a
          href="https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run"
          target="_blank"
          rel="noopener noreferrer"
        >
          docs
        </a>{" "}
        for .NET file-based run.
      </p>

      {RUNTIME_ROWS.map(({ field, label, help }) => (
        <div className="form-group" key={field}>
          <label className="form-label" htmlFor={`runtime-${field}`}>
            {label}
          </label>
          <input
            id={`runtime-${field}`}
            className="form-input"
            type="text"
            value={runtimes![field]}
            onChange={(e) =>
              setRuntimes((prev) => ({ ...prev!, [field]: e.target.value }))
            }
            placeholder={`/path/to/${label}`}
          />
          <p className="muted" style={{ fontSize: "12px", marginTop: "2px" }}>
            {help}
          </p>
        </div>
      ))}

      <button type="submit" disabled={saving} className="btn btn--primary">
        {saving ? "Saving…" : "Save"}
      </button>
      {msg && <div className="auth-ok" style={{ marginTop: "8px" }}>{msg}</div>}
      {err && <div className="auth-error" style={{ marginTop: "8px" }}>{err}</div>}
    </form>
  );
}

// ── Global Calendar Admin Section ─────────────────────────────────────────────

function GlobalCalendarSection() {
  const [exceptions, setExceptions] = useState<CalendarException[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [weekendYear, setWeekendYear] = useState(new Date().getFullYear());
  const [weekendBusy, setWeekendBusy] = useState(false);
  const [weekendMsg, setWeekendMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setExceptions(await listGlobalCalendarExceptions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleFetchHolidays = async (countryCode: string, year: number) => {
    await new Promise<void>((resolve, reject) => {
      const { done } = streamFetchHolidays(countryCode, year, () => {});
      done.then(resolve).catch(reject);
    });
    await reload();
  };

  const handleMarkWeekends = async (e: React.FormEvent) => {
    e.preventDefault();
    setWeekendBusy(true);
    setWeekendMsg(null);
    setError(null);
    try {
      const { count } = await markWeekendsAsNonWorking(weekendYear);
      setWeekendMsg(`Marked ${count} new weekend days as non-working for ${weekendYear}.`);
      await reload();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setWeekendBusy(false);
    }
  };

  return (
    <div className="profile">
      <h2>Global Calendar</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Non-working days set here apply across all projects and users unless
        overridden at a lower scope. Use "Fetch holidays" to auto-import national
        public holidays via an agent.
      </p>

      <form onSubmit={(e) => void handleMarkWeekends(e)} style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Mark all weekends as non-working for year</span>
          <input
            type="number"
            min={1970}
            max={2100}
            value={weekendYear}
            onChange={(e) => setWeekendYear(Number(e.target.value))}
            disabled={weekendBusy}
            style={{ width: 90 }}
          />
        </label>
        <button type="submit" className="btn btn--sm" disabled={weekendBusy}>
          {weekendBusy ? "Marking…" : "Mark weekends"}
        </button>
        {weekendMsg && <span style={{ fontSize: 12, color: "var(--ok, #38a169)" }}>{weekendMsg}</span>}
      </form>

      {error && <div className="auth-error">{error}</div>}
      <CalendarExceptionEditor
        exceptions={exceptions}
        canEdit
        scope="global"
        onAdd={async (date, kind, name) => {
          await createGlobalCalendarException({ date, kind, name });
          await reload();
        }}
        onUpdate={async (id, patch) => {
          await patchCalendarException("global", id, patch);
          await reload();
        }}
        onDelete={async (id) => {
          await deleteCalendarException("global", id);
          await reload();
        }}
        onFetchHolidays={handleFetchHolidays}
      />
    </div>
  );
}

// ── User Personal Calendar Section ───────────────────────────────────────────

function UserCalendarSection() {
  const [exceptions, setExceptions] = useState<CalendarException[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setExceptions(await listUserCalendarExceptions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <div>
      <h2>My Calendar</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Mark personal vacation days or working exceptions. Your calendar takes
        priority over all other scopes.
      </p>
      {error && <div className="auth-error">{error}</div>}
      <CalendarExceptionEditor
        exceptions={exceptions}
        canEdit
        scope="user"
        onAdd={async (date, kind, name) => {
          await createUserCalendarException({ date, kind, name });
          await reload();
        }}
        onUpdate={async (id, patch) => {
          await patchCalendarException("user", id, patch);
          await reload();
        }}
        onDelete={async (id) => {
          await deleteCalendarException("user", id);
          await reload();
        }}
      />
    </div>
  );
}
