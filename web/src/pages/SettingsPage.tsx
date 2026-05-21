import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(
    initialSub && user.role === "admin" ? initialSub : "profile",
  );
  const loadingFallback = <div className="app-loading">{t("page.settings.loading")}</div>;

  return (
    <div className="settings">
      <nav className="settings-nav">
        <button
          className={tab === "profile" ? "active" : ""}
          onClick={() => setTab("profile")}
        >
          {t("page.settings.nav.profile")}
        </button>
        <button className={tab === "keys" ? "active" : ""} onClick={() => setTab("keys")}>
          {t("page.settings.nav.apiKeys")}
        </button>
        {user.role === "admin" && (
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            {t("page.settings.nav.users")}
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>
            {t("page.settings.nav.prompts")}
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "trash" ? "active" : ""} onClick={() => setTab("trash")}>
            {t("page.settings.nav.trash")}
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
            {t("page.settings.nav.logs")}
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "runtimes" ? "active" : ""} onClick={() => setTab("runtimes")}>
            {t("page.settings.nav.scriptRuntimes")}
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "feed_patterns" ? "active" : ""} onClick={() => setTab("feed_patterns")}>
            {t("page.settings.nav.feedPatterns")}
          </button>
        )}
        {user.role === "admin" && (
          <button className={tab === "calendar" ? "active" : ""} onClick={() => setTab("calendar")}>
            {t("page.settings.nav.calendar")}
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
          <Suspense fallback={loadingFallback}>
            <PromptsAdminTab />
          </Suspense>
        )}
        {tab === "trash" && user.role === "admin" && (
          <Suspense fallback={loadingFallback}>
            <TrashTab />
          </Suspense>
        )}
        {tab === "logs" && user.role === "admin" && (
          <Suspense fallback={loadingFallback}>
            <LogsTab initialErrorsOnly={initialLogsErrorsOnly} />
          </Suspense>
        )}
        {tab === "runtimes" && user.role === "admin" && (
          <ScriptRuntimesForm />
        )}
        {tab === "feed_patterns" && user.role === "admin" && (
          <Suspense fallback={loadingFallback}>
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
  const { t } = useTranslation();
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
      setMsg(t("page.settings.profile.savedProfile"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("page.settings.profile.errSaveFailed"));
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
      setMsg(t("page.settings.profile.savedPassword"));
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : t("page.settings.profile.errChangePasswordFailed"),
      );
    }
  };

  return (
    <div className="profile">
      <form onSubmit={save}>
        <h2>{t("page.settings.profile.heading")}</h2>
        <div className="read-only">
          <div>
            <span className="muted">{t("page.settings.profile.username")}</span>
            <span>{user.username}</span>
          </div>
          <div>
            <span className="muted">{t("page.settings.profile.role")}</span>
            <span>{user.role}</span>
          </div>
        </div>
        <label>
          <span>{t("page.settings.profile.displayName")}</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          <span>{t("page.settings.profile.email")}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          <span>{t("page.settings.profile.preferredLanguage")}</span>
          <select
            value={preferredLang}
            onChange={(e) => setPreferredLang(e.target.value)}
          >
            <option value="">{t("page.settings.profile.followProjectDefault")}</option>
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.code.toUpperCase()} · {opt.name}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("page.settings.profile.preferredLanguageHelp")}
          </span>
        </label>
        <label>
          <span>{t("page.settings.profile.defaultQuickChatProject")}</span>
          <select
            value={defaultQcProject}
            onChange={(e) => setDefaultQcProject(e.target.value)}
          >
            <option value="">{t("page.settings.profile.noneActiveProject")}</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("page.settings.profile.defaultQuickChatHelp")}
          </span>
        </label>
        <h3>{t("page.settings.profile.chatDisplay")}</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={expandThink}
            onChange={(e) => setExpandThink(e.target.checked)}
          />
          <span>{t("page.settings.profile.expandThink")}</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={expandTool}
            onChange={(e) => setExpandTool(e.target.checked)}
          />
          <span>{t("page.settings.profile.expandTool")}</span>
        </label>
        <button type="submit">{t("page.settings.profile.saveProfile")}</button>
      </form>

      <form onSubmit={submitPw}>
        <h2>{t("page.settings.profile.passwordHeading")}</h2>
        <label>
          <span>{t("page.settings.profile.currentPassword")}</span>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            required
          />
        </label>
        <label>
          <span>{t("page.settings.profile.newPassword")}</span>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            required
          />
        </label>
        <button type="submit">{t("page.settings.profile.changePassword")}</button>
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
  const { t } = useTranslation();
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
        setErr(e instanceof Error ? e.message : t("page.settings.soul.errLoad")),
      );
    return () => {
      cancelled = true;
    };
  }, [t]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      const next = await updateOwnSoul(draft);
      setInfo(next);
      setDraft(next.soul);
      setMsg(t("page.settings.soul.saved"));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("page.settings.soul.errSave"));
    } finally {
      setSaving(false);
    }
  };

  const cap = info?.maxChars ?? 4000;
  const formatted =
    info?.refreshedAt != null
      ? new Date(info.refreshedAt).toLocaleString()
      : t("page.settings.soul.never");

  return (
    <form onSubmit={save}>
      <h2>{t("page.settings.soul.heading")}</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>
        {t("page.settings.soul.description")}
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, cap))}
        rows={10}
        style={{ width: "100%", fontFamily: "inherit", fontSize: 14 }}
        placeholder={t("page.settings.soul.placeholder")}
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
          {t("page.settings.soul.counter", { used: draft.length, cap })}
        </span>
        <span>
          {t("page.settings.soul.statusLine", {
            status: info?.status ?? t("page.settings.soul.unknownStatus"),
            when: formatted,
          })}
        </span>
      </div>
      <button type="submit" disabled={saving}>
        {saving ? t("page.settings.soul.saving") : t("page.settings.soul.save")}
      </button>
      {msg && <div className="auth-ok">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}
    </form>
  );
}

// ── Script Runtimes Admin Form ────────────────────────────────────────────────

const RUNTIME_FIELDS: ReadonlyArray<keyof ScriptRuntimes> = [
  "dotnetPath",
  "pythonPath",
  "powershellPath",
  "goPath",
  "bunPath",
];

function runtimeRowText(
  field: keyof ScriptRuntimes,
  t: ReturnType<typeof useTranslation>["t"],
): { label: string; help: string } {
  switch (field) {
    case "dotnetPath":
      return {
        label: t("page.settings.runtimes.rows.dotnet.label"),
        help: t("page.settings.runtimes.rows.dotnet.help"),
      };
    case "pythonPath":
      return {
        label: t("page.settings.runtimes.rows.python.label"),
        help: t("page.settings.runtimes.rows.python.help"),
      };
    case "powershellPath":
      return {
        label: t("page.settings.runtimes.rows.powershell.label"),
        help: t("page.settings.runtimes.rows.powershell.help"),
      };
    case "goPath":
      return {
        label: t("page.settings.runtimes.rows.go.label"),
        help: t("page.settings.runtimes.rows.go.help"),
      };
    case "bunPath":
      return {
        label: t("page.settings.runtimes.rows.bun.label"),
        help: t("page.settings.runtimes.rows.bun.help"),
      };
  }
}

function ScriptRuntimesForm() {
  const { t } = useTranslation();
  const [runtimes, setRuntimes] = useState<ScriptRuntimes | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchScriptRuntimes()
      .then(setRuntimes)
      .catch(() => setErr(t("page.settings.runtimes.errLoad")));
  }, [t]);

  if (!runtimes) return <div className="loading-state">{t("page.settings.loading")}</div>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      await patchScriptRuntimes(runtimes!);
      setMsg(t("page.settings.runtimes.saved"));
    } catch {
      setErr(t("page.settings.runtimes.errSave"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="profile" onSubmit={handleSubmit}>
      <h2>{t("page.settings.runtimes.heading")}</h2>
      <p className="muted" style={{ marginBottom: "16px" }}>
        {t("page.settings.runtimes.descriptionPrefix")}
        <a
          href="https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("page.settings.runtimes.descriptionLink")}
        </a>
        {t("page.settings.runtimes.descriptionSuffix")}
      </p>

      {RUNTIME_FIELDS.map((field) => {
        const { label, help } = runtimeRowText(field, t);
        return (
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
              placeholder={t("page.settings.runtimes.pathPlaceholder", { label })}
            />
            <p className="muted" style={{ fontSize: "12px", marginTop: "2px" }}>
              {help}
            </p>
          </div>
        );
      })}

      <button type="submit" disabled={saving} className="btn btn--primary">
        {saving
          ? t("page.settings.runtimes.saving")
          : t("page.settings.runtimes.save")}
      </button>
      {msg && <div className="auth-ok" style={{ marginTop: "8px" }}>{msg}</div>}
      {err && <div className="auth-error" style={{ marginTop: "8px" }}>{err}</div>}
    </form>
  );
}

// ── Global Calendar Admin Section ─────────────────────────────────────────────

function GlobalCalendarSection() {
  const { t } = useTranslation();
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
      setWeekendMsg(
        t("page.settings.globalCalendar.weekendsMarked", {
          count,
          year: weekendYear,
        }),
      );
      await reload();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setWeekendBusy(false);
    }
  };

  return (
    <div className="profile">
      <h2>{t("page.settings.globalCalendar.heading")}</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        {t("page.settings.globalCalendar.description")}
      </p>

      <form onSubmit={(e) => void handleMarkWeekends(e)} style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {t("page.settings.globalCalendar.markWeekendsLabel")}
          </span>
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
          {weekendBusy
            ? t("page.settings.globalCalendar.marking")
            : t("page.settings.globalCalendar.markWeekends")}
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
  const { t } = useTranslation();
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
      <h2>{t("page.settings.userCalendar.heading")}</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        {t("page.settings.userCalendar.description")}
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
