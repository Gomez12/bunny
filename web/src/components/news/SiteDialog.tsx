import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  createNewsTopic,
  updateNewsTopic,
  type NewsTopic,
} from "../../api";
import { Globe, Loader2, X } from "../../lib/icons";
import Modal from "../Modal";

const CRON_PRESETS: Array<{ key: "hourly" | "every6h" | "daily7" | "weeklyMon8"; value: string }> = [
  { key: "hourly", value: "0 * * * *" },
  { key: "every6h", value: "0 */6 * * *" },
  { key: "daily7", value: "0 7 * * *" },
  { key: "weeklyMon8", value: "0 8 * * 1" },
];

function presetLabel(
  key: (typeof CRON_PRESETS)[number]["key"],
  t: TFunction,
): string {
  switch (key) {
    case "hourly":
      return t("dialog.cronPresets.hourly");
    case "every6h":
      return t("dialog.cronPresets.every6h");
    case "daily7":
      return t("dialog.cronPresets.daily7");
    case "weeklyMon8":
      return t("dialog.cronPresets.weeklyMon8");
  }
}

type Props = {
  project: string;
  initial?: NewsTopic;
  onCancel: () => void;
  onDone: () => void;
};

export default function SiteDialog({ project, initial, onCancel, onDone }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [siteUrl, setSiteUrl] = useState(initial?.siteUrl ?? "");
  const [updateCron, setUpdateCron] = useState(initial?.updateCron ?? "0 */6 * * *");
  const [maxItemsPerRun, setMaxItemsPerRun] = useState(initial?.maxItemsPerRun ?? 10);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No agent selection needed — the backend uses the built-in `news` agent.

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!siteUrl.trim()) { setError(t("dialog.site.errSiteUrlRequired")); return; }
    if (!name.trim()) { setError(t("dialog.site.errNameRequired")); return; }
    setSubmitting(true);
    setError(null);
    try {
      if (initial) {
        await updateNewsTopic(project, initial.id, {
          name, description, updateCron, maxItemsPerRun, enabled,
          siteUrl: siteUrl.trim(),
        });
      } else {
        await createNewsTopic(project, {
          topicType: "site_monitor",
          name, description, updateCron, maxItemsPerRun, enabled,
          siteUrl: siteUrl.trim(),
          terms: [],
        });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onCancel} size="md">
      <form onSubmit={(e) => void handleSubmit(e)}>
        <Modal.Header
          title={initial ? t("dialog.site.titleEdit") : t("dialog.site.titleCreate")}
        />
        <Modal.Body>
          {error && <p className="form-error" style={{ marginBottom: "12px" }}>{error}</p>}
          <p className="form-hint" style={{ marginBottom: "12px" }}>{t("dialog.site.intro")}</p>

          {/* ── Site URL ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="site-url">{t("dialog.site.siteUrlLabel")}</label>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <Globe size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
              <input
                id="site-url"
                type="url"
                className="input"
                placeholder={t("dialog.site.siteUrlPlaceholder")}
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                required
                style={{ flex: 1 }}
              />
            </div>
          </div>

          {/* ── Name ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="site-name">{t("dialog.site.nameLabel")}</label>
            <input
              id="site-name"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          {/* ── Description ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="site-desc">{t("dialog.site.descriptionLabel")}</label>
            <input
              id="site-desc"
              type="text"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* ── Schedule ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="site-cron">{t("dialog.site.scheduleLabel")}</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                id="site-cron"
                type="text"
                className="input"
                value={updateCron}
                onChange={(e) => setUpdateCron(e.target.value)}
                required
                style={{ flex: 1 }}
              />
              <select
                className="input"
                style={{ width: "auto" }}
                value={CRON_PRESETS.find((p) => p.value === updateCron)?.value ?? ""}
                onChange={(e) => { if (e.target.value) setUpdateCron(e.target.value); }}
              >
                <option value="">{t("dialog.cronPresets.label")}</option>
                {CRON_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {presetLabel(p.key, t)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Max items ── */}
          <div className="form-group">
            <label className="form-label">{t("dialog.site.maxItemsLabel", { count: maxItemsPerRun })}</label>
            <input
              type="range"
              min={1}
              max={100}
              value={maxItemsPerRun}
              onChange={(e) => setMaxItemsPerRun(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>

          {/* ── Enabled ── */}
          <div className="form-group" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              id="site-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor="site-enabled" className="form-label" style={{ margin: 0 }}>
              {t("dialog.site.enabledLabel")}
            </label>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            <X size={14} /> {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? <Loader2 size={14} className="spin" /> : null}
            {initial ? t("common.save") : t("dialog.site.addMonitor")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
