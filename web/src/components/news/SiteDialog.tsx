import { useState } from "react";
import {
  createNewsTopic,
  updateNewsTopic,
  type NewsTopic,
} from "../../api";
import { Globe, Loader2, X } from "../../lib/icons";
import Modal from "../Modal";

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily 07:00", value: "0 7 * * *" },
  { label: "Weekly Mon 08:00", value: "0 8 * * 1" },
];

type Props = {
  project: string;
  initial?: NewsTopic;
  onCancel: () => void;
  onDone: () => void;
};

export default function SiteDialog({ project, initial, onCancel, onDone }: Props) {
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
    if (!siteUrl.trim()) { setError("Site URL is required"); return; }
    if (!name.trim()) { setError("Name is required"); return; }
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
        <Modal.Header title={initial ? "Edit site monitor" : "New site monitor"} />
        <Modal.Body>
          {error && <p className="form-error" style={{ marginBottom: "12px" }}>{error}</p>}
          <p className="form-hint" style={{ marginBottom: "12px" }}>
            The agent checks this page periodically for changes.
            Only the LLM is called when content actually changes — ephemeral HTML
            differences (ads, timestamps) are filtered out first.
          </p>

          {/* ── Site URL ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="site-url">Site URL</label>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <Globe size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
              <input
                id="site-url"
                type="url"
                className="input"
                placeholder="https://example.com/updates"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                required
                style={{ flex: 1 }}
              />
            </div>
          </div>

          {/* ── Name ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="site-name">Name</label>
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
            <label className="form-label" htmlFor="site-desc">Description</label>
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
            <label className="form-label" htmlFor="site-cron">Check schedule</label>
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
                <option value="">Preset…</option>
                {CRON_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>

          {/* ── Max items ── */}
          <div className="form-group">
            <label className="form-label">Max items per run: {maxItemsPerRun}</label>
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
              Enabled
            </label>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            <X size={14} /> Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? <Loader2 size={14} className="spin" /> : null}
            {initial ? "Save" : "Add monitor"}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
