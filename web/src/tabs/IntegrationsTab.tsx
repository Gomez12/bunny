import { useEffect, useState } from "react";
import type { AuthUser } from "../api";
import {
  deleteTelegramConfigApi,
  fetchTelegramConfig,
  regenerateTelegramWebhookSecret,
  saveTelegramConfig,
  telegramTestSend,
  type TelegramConfigDto,
} from "../api";
import { Copy, RefreshCw, Send, Trash2, Check } from "../lib/icons";

/**
 * Integrations sub-tab: v1 surface is the per-project Telegram bot config.
 * Only admins and the project creator can see/edit it — the route enforces
 * the same, we just hide the controls for less-privileged viewers.
 */
export default function IntegrationsTab({
  currentUser,
  activeProject,
}: {
  currentUser: AuthUser;
  activeProject: string;
}) {
  const [config, setConfig] = useState<TelegramConfigDto | null>(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Form state
  const [botToken, setBotToken] = useState("");
  const [transport, setTransport] = useState<"poll" | "webhook">("poll");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Test send state
  const [testChatId, setTestChatId] = useState("");
  const [testText, setTestText] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setForbidden(false);
    fetchTelegramConfig(activeProject)
      .then((r) => {
        if (cancelled) return;
        setConfig(r.config);
        setPublicBaseUrl(r.publicBaseUrl);
        if (r.config) {
          setTransport(r.config.transport);
          setEnabled(r.config.enabled);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (e.message === "forbidden") setForbidden(true);
        else setErr(e.message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [activeProject]);

  if (loading) return <div className="app-loading">Loading…</div>;
  if (forbidden) {
    return (
      <div className="integrations-tab">
        <p className="muted">
          You don't have permission to configure integrations for this project.
        </p>
      </div>
    );
  }

  const save = async () => {
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      const patch: Parameters<typeof saveTelegramConfig>[1] = {
        transport,
        enabled,
      };
      if (botToken.trim()) patch.botToken = botToken.trim();
      const r = await saveTelegramConfig(activeProject, patch);
      setConfig(r.config);
      setBotToken("");
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Disconnect Telegram for this project?")) return;
    setSaving(true);
    try {
      await deleteTelegramConfigApi(activeProject);
      setConfig(null);
      setMsg("Telegram disconnected.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const rotateSecret = async () => {
    setSaving(true);
    try {
      await regenerateTelegramWebhookSecret(activeProject);
      const r = await fetchTelegramConfig(activeProject);
      setConfig(r.config);
      setMsg("Webhook secret rotated.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testSend = async () => {
    setErr(null);
    const cid = Number(testChatId.trim());
    if (!Number.isFinite(cid)) {
      setErr("Chat ID must be a number");
      return;
    }
    try {
      await telegramTestSend(activeProject, cid, testText.trim() || undefined);
      setMsg(`Sent test message to chat ${cid}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="integrations-tab">
      <header className="tab-header">
        <h2>Integrations</h2>
        <p className="muted">
          Third-party services wired into project <strong>{activeProject}</strong>.
          Only admins and the project creator can change these settings.
        </p>
      </header>

      <section className="integration-card">
        <header className="integration-card__head">
          <Send size={20} strokeWidth={1.75} />
          <div>
            <h3>Telegram</h3>
            <p className="muted">
              Link a Telegram bot to chat with this project from your phone and
              receive notifications, card-run results, and news digests.
            </p>
          </div>
        </header>

        {config ? (
          <div className="integration-card__state">
            <div className="kv">
              <span>Bot</span>
              <strong>@{config.botUsername}</strong>{" "}
              <span className="muted">({config.botTokenMasked})</span>
            </div>
            <div className="kv">
              <span>Transport</span>
              <strong>{config.transport}</strong>
            </div>
            <div className="kv">
              <span>Enabled</span>
              <strong>{config.enabled ? "yes" : "no"}</strong>
            </div>
            {config.webhookUrl && (
              <div className="kv">
                <span>Webhook URL</span>
                <code>{config.webhookUrl}</code>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() =>
                    navigator.clipboard.writeText(config.webhookUrl ?? "")
                  }
                  title="Copy URL"
                >
                  <Copy size={16} strokeWidth={1.75} />
                </button>
              </div>
            )}
            <div className="kv">
              <span>Last update id</span>
              <strong>{config.lastUpdateId}</strong>
            </div>
          </div>
        ) : (
          <p className="muted">
            No bot configured. Create one with @BotFather, then paste its token
            below.
          </p>
        )}

        <div className="integration-form">
          <label>
            <span>Bot token {config ? "(leave blank to keep existing)" : ""}</span>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:AA…"
              autoComplete="off"
            />
          </label>

          <fieldset className="radios">
            <legend>Transport</legend>
            <label>
              <input
                type="radio"
                name="tg-transport"
                checked={transport === "poll"}
                onChange={() => setTransport("poll")}
              />
              Short-polling (default — works anywhere)
            </label>
            <label>
              <input
                type="radio"
                name="tg-transport"
                checked={transport === "webhook"}
                onChange={() => setTransport("webhook")}
                disabled={!publicBaseUrl}
                title={
                  publicBaseUrl
                    ? undefined
                    : "Set BUNNY_PUBLIC_BASE_URL to enable webhook mode"
                }
              />
              Webhook
              {publicBaseUrl ? "" : " (requires BUNNY_PUBLIC_BASE_URL)"}
            </label>
          </fieldset>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>

          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={save}
              disabled={saving || (!config && !botToken.trim())}
            >
              {saving ? "Saving…" : config ? "Update" : "Connect"}
            </button>
            {config && (
              <>
                {transport === "webhook" && (
                  <button
                    type="button"
                    className="btn"
                    onClick={rotateSecret}
                    disabled={saving}
                  >
                    <RefreshCw size={16} strokeWidth={1.75} /> Rotate secret
                  </button>
                )}
                {currentUser.role === "admin" && (
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={remove}
                    disabled={saving}
                  >
                    <Trash2 size={16} strokeWidth={1.75} /> Disconnect
                  </button>
                )}
              </>
            )}
          </div>

          {config && (
            <div className="test-send">
              <h4>Test send</h4>
              <div className="test-send__row">
                <input
                  placeholder="Chat ID (e.g. 123456789)"
                  value={testChatId}
                  onChange={(e) => setTestChatId(e.target.value)}
                />
                <input
                  placeholder="Message (optional)"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={testSend}
                  disabled={!testChatId.trim()}
                >
                  <Check size={16} strokeWidth={1.75} /> Send
                </button>
              </div>
              <p className="muted">
                Find a chat's numeric ID via{" "}
                <code>@userinfobot</code> or the bot's <code>getMe</code>{" "}
                response.
              </p>
            </div>
          )}

          {msg && <p className="success">{msg}</p>}
          {err && <p className="error">{err}</p>}
        </div>
      </section>
    </div>
  );
}
