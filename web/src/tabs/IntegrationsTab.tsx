import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import ConfirmDialog from "../components/ConfirmDialog";

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
  const { t } = useTranslation();
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
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

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

  if (loading) return <div className="app-loading">{t("tab.integrations.loading")}</div>;
  if (forbidden) {
    return (
      <div className="integrations-tab">
        <p className="muted">{t("tab.integrations.forbidden")}</p>
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
      setMsg(t("tab.integrations.telegram.msgSaved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await deleteTelegramConfigApi(activeProject);
      setConfig(null);
      setMsg(t("tab.integrations.telegram.msgDisconnected"));
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
      setMsg(t("tab.integrations.telegram.msgSecretRotated"));
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
      setErr(t("tab.integrations.telegram.errChatIdNotNumber"));
      return;
    }
    try {
      await telegramTestSend(activeProject, cid, testText.trim() || undefined);
      setMsg(t("tab.integrations.telegram.msgSent", { chatId: cid }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="integrations-tab">
      <header className="tab-header">
        <h2>{t("tab.integrations.title")}</h2>
        <p className="muted">
          <Trans
            i18nKey="tab.integrations.descriptionFull"
            values={{ project: activeProject }}
            components={{ strong: <strong /> }}
          />
        </p>
      </header>

      <section className="integration-card">
        <header className="integration-card__head">
          <Send size={20} strokeWidth={1.75} />
          <div>
            <h3>{t("tab.integrations.telegram.name")}</h3>
            <p className="muted">{t("tab.integrations.telegram.description")}</p>
          </div>
        </header>

        {config ? (
          <div className="integration-card__state">
            <div className="kv">
              <span>{t("tab.integrations.telegram.kv.bot")}</span>
              <strong>@{config.botUsername}</strong>{" "}
              <span className="muted">({config.botTokenMasked})</span>
            </div>
            <div className="kv">
              <span>{t("tab.integrations.telegram.kv.transport")}</span>
              <strong>{config.transport}</strong>
            </div>
            <div className="kv">
              <span>{t("tab.integrations.telegram.kv.enabled")}</span>
              <strong>
                {config.enabled
                  ? t("tab.integrations.telegram.kv.yes")
                  : t("tab.integrations.telegram.kv.no")}
              </strong>
            </div>
            {config.webhookUrl && (
              <div className="kv">
                <span>{t("tab.integrations.telegram.kv.webhookUrl")}</span>
                <code>{config.webhookUrl}</code>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() =>
                    navigator.clipboard.writeText(config.webhookUrl ?? "")
                  }
                  title={t("tab.integrations.telegram.copyUrl")}
                >
                  <Copy size={16} strokeWidth={1.75} />
                </button>
              </div>
            )}
            <div className="kv">
              <span>{t("tab.integrations.telegram.kv.lastUpdateId")}</span>
              <strong>{config.lastUpdateId}</strong>
            </div>
          </div>
        ) : (
          <p className="muted">{t("tab.integrations.telegram.noBot")}</p>
        )}

        <div className="integration-form">
          <label>
            <span>
              {config
                ? t("tab.integrations.telegram.botTokenLabelExisting")
                : t("tab.integrations.telegram.botTokenLabel")}
            </span>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:AA…"
              autoComplete="off"
            />
          </label>

          <fieldset className="radios">
            <legend>{t("tab.integrations.telegram.transportLegend")}</legend>
            <label>
              <input
                type="radio"
                name="tg-transport"
                checked={transport === "poll"}
                onChange={() => setTransport("poll")}
              />
              {t("tab.integrations.telegram.transportPoll")}
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
                    : t("tab.integrations.telegram.transportWebhookDisabledTitle")
                }
              />
              {t("tab.integrations.telegram.transportWebhook")}
              {publicBaseUrl
                ? ""
                : t("tab.integrations.telegram.transportWebhookSuffix")}
            </label>
          </fieldset>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("tab.integrations.telegram.enabledCheckbox")}
          </label>

          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={save}
              disabled={saving || (!config && !botToken.trim())}
            >
              {saving
                ? t("tab.integrations.telegram.saving")
                : config
                  ? t("tab.integrations.telegram.update")
                  : t("tab.integrations.telegram.connect")}
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
                    <RefreshCw size={16} strokeWidth={1.75} />{" "}
                    {t("tab.integrations.telegram.rotateSecret")}
                  </button>
                )}
                {currentUser.role === "admin" && (
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={saving}
                  >
                    <Trash2 size={16} strokeWidth={1.75} />{" "}
                    {t("tab.integrations.telegram.disconnect")}
                  </button>
                )}
              </>
            )}
          </div>

          {config && (
            <div className="test-send">
              <h4>{t("tab.integrations.telegram.testSend")}</h4>
              <div className="test-send__row">
                <input
                  placeholder={t("tab.integrations.telegram.testChatIdPlaceholder")}
                  value={testChatId}
                  onChange={(e) => setTestChatId(e.target.value)}
                />
                <input
                  placeholder={t("tab.integrations.telegram.testMessagePlaceholder")}
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={testSend}
                  disabled={!testChatId.trim()}
                >
                  <Check size={16} strokeWidth={1.75} />{" "}
                  {t("tab.integrations.telegram.send")}
                </button>
              </div>
              <p className="muted">
                <Trans
                  i18nKey="tab.integrations.telegram.testSendHelp"
                  components={{ code: <code /> }}
                />
              </p>
            </div>
          )}

          {msg && <p className="success">{msg}</p>}
          {err && <p className="error">{err}</p>}
        </div>
      </section>
      <ConfirmDialog
        open={confirmDisconnect}
        message={t("tab.integrations.telegram.disconnectConfirm")}
        confirmLabel={t("tab.integrations.telegram.disconnect")}
        onConfirm={() => { setConfirmDisconnect(false); void remove(); }}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </div>
  );
}
