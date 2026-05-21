import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  createNewsTopic,
  discoverFeeds,
  fetchFeedPatterns,
  updateNewsTopic,
  type DiscoveredFeed,
  type FeedPattern,
  type NewsTopic,
} from "../../api";
import { ExternalLink, Globe, Loader2, Rss, Search, X } from "../../lib/icons";
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

type DiscoverState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; feeds: DiscoveredFeed[] }
  | { kind: "error"; message: string };

type Props = {
  project: string;
  initial?: NewsTopic;
  onCancel: () => void;
  onDone: () => void;
};

export default function FeedDialog({ project, initial, onCancel, onDone }: Props) {
  const { t } = useTranslation();
  const [patterns, setPatterns] = useState<FeedPattern[]>([]);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [feedUrl, setFeedUrl] = useState(initial?.feedUrl ?? "");
  const [updateCron, setUpdateCron] = useState(initial?.updateCron ?? "0 */6 * * *");
  const [maxItemsPerRun, setMaxItemsPerRun] = useState(initial?.maxItemsPerRun ?? 10);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  // Pattern picker
  const [discoverUrl, setDiscoverUrl] = useState("");
  const [discoverState, setDiscoverState] = useState<DiscoverState>({ kind: "idle" });
  const [selectedSite, setSelectedSite] = useState("");
  const [selectedPattern, setSelectedPattern] = useState<FeedPattern | null>(null);
  const [patternVarValues, setPatternVarValues] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetchFeedPatterns().then(setPatterns);
  }, []);

  const sites = useMemo(
    () => [...new Set(patterns.map((p) => p.site))].sort(),
    [patterns],
  );

  // Render an `<a href>` only when the URL is a well-formed http(s) URL.
  // Prevents `javascript:` / `data:` URLs typed into the input from becoming
  // an XSS vector when the user clicks the "open feed" button.
  const safeFeedHref = useMemo(() => {
    const trimmed = feedUrl.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.href;
    } catch {
      return null;
    }
  }, [feedUrl]);

  const patternsForSite = useMemo(
    () => patterns.filter((p) => p.site === selectedSite),
    [patterns, selectedSite],
  );

  const resolvedPatternUrl = useMemo(() => {
    if (!selectedPattern) return "";
    let url = selectedPattern.pattern;
    for (const v of selectedPattern.variables) {
      url = url.replace(`{${v.name}}`, patternVarValues[v.name] ?? "");
    }
    return url;
  }, [selectedPattern, patternVarValues]);

  const handleDiscover = async () => {
    const url = discoverUrl.trim();
    if (!url) return;
    setDiscoverState({ kind: "loading" });
    try {
      const feeds = await discoverFeeds(project, url);
      if (feeds.length === 0) {
        setDiscoverState({ kind: "error", message: t("dialog.feed.discoverNone") });
      } else {
        setDiscoverState({ kind: "done", feeds });
        if (feeds.length === 1) {
          setFeedUrl(feeds[0]!.url);
          if (!name) {
            setName(feeds[0]!.title.slice(0, 80));
          }
        }
      }
    } catch (e) {
      setDiscoverState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const applyPattern = () => {
    const url = resolvedPatternUrl.trim();
    if (!url || url.includes("{")) return;
    setFeedUrl(url);
    if (!name && selectedPattern) {
      setName(`${selectedSite} — ${selectedPattern.name}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedUrl.trim()) { setError(t("dialog.feed.errFeedUrlRequired")); return; }
    if (!name.trim()) { setError(t("dialog.feed.errNameRequired")); return; }
    setSubmitting(true);
    setError(null);
    try {
      if (initial) {
        await updateNewsTopic(project, initial.id, {
          name, description, updateCron, maxItemsPerRun, enabled, feedUrl: feedUrl.trim(),
        });
      } else {
        await createNewsTopic(project, {
          topicType: "rss_feed",
          name, description, updateCron, maxItemsPerRun, enabled,
          feedUrl: feedUrl.trim(),
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
          title={initial ? t("dialog.feed.titleEdit") : t("dialog.feed.titleCreate")}
        />
        <Modal.Body>
          {error && <p className="form-error" style={{ marginBottom: "12px" }}>{error}</p>}

          {/* ── Feed URL ── */}
          <fieldset className="form-group">
            <legend className="form-label">{t("dialog.feed.feedUrlLegend")}</legend>

            {/* Discover from page */}
            <p className="form-hint" style={{ marginBottom: "8px" }}>{t("dialog.feed.discoverHint")}</p>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                ref={urlRef}
                type="url"
                className="input"
                placeholder={t("dialog.feed.discoverPlaceholder")}
                value={discoverUrl}
                onChange={(e) => setDiscoverUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleDiscover(); } }}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => void handleDiscover()}
                disabled={discoverState.kind === "loading" || !discoverUrl.trim()}
              >
                {discoverState.kind === "loading" ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                {t("dialog.feed.discover")}
              </button>
            </div>
            {discoverState.kind === "done" && discoverState.feeds.length > 0 && (
              <ul style={{ margin: "0 0 8px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "4px" }}>
                {discoverState.feeds.map((f) => (
                  <li key={f.url}>
                    <button
                      type="button"
                      className={`btn btn--ghost btn--sm ${feedUrl === f.url ? "btn--active" : ""}`}
                      style={{ width: "100%", justifyContent: "flex-start", gap: "6px", textAlign: "left" }}
                      onClick={() => { setFeedUrl(f.url); if (!name) setName(f.title.slice(0, 80)); }}
                    >
                      {f.format === "atom" ? <Globe size={12} /> : <Rss size={12} />}
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title || f.url}</span>
                      <span style={{ opacity: 0.5, fontSize: "11px" }}>{f.format.toUpperCase()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {discoverState.kind === "error" && (
              <p className="form-error" style={{ marginBottom: "8px" }}>{discoverState.message}</p>
            )}

            {/* Pattern picker */}
            {patterns.length > 0 && (
              <details style={{ marginBottom: "8px" }}>
                <summary className="form-hint" style={{ cursor: "pointer", userSelect: "none" }}>
                  {t("dialog.feed.patternSummary")}
                </summary>
                <div style={{ paddingTop: "8px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <select
                      className="input"
                      value={selectedSite}
                      onChange={(e) => { setSelectedSite(e.target.value); setSelectedPattern(null); setPatternVarValues({}); }}
                    >
                      <option value="">{t("dialog.feed.siteOption")}</option>
                      {sites.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {selectedSite && (
                      <select
                        className="input"
                        value={selectedPattern?.id ?? ""}
                        onChange={(e) => {
                          const p = patternsForSite.find((x) => x.id === Number(e.target.value)) ?? null;
                          setSelectedPattern(p);
                          setPatternVarValues({});
                        }}
                      >
                        <option value="">{t("dialog.feed.patternOption")}</option>
                        {patternsForSite.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </div>
                  {selectedPattern && selectedPattern.variables.map((v) => (
                    <div key={v.name}>
                      <label className="form-label">{v.label}</label>
                      <input
                        type="text"
                        className="input"
                        placeholder={v.hint ?? v.name}
                        value={patternVarValues[v.name] ?? ""}
                        onChange={(e) => setPatternVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                      />
                    </div>
                  ))}
                  {selectedPattern && (
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <code style={{ flex: 1, fontSize: "12px", opacity: 0.7, wordBreak: "break-all" }}>{resolvedPatternUrl}</code>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={applyPattern}
                        disabled={resolvedPatternUrl.includes("{") || !resolvedPatternUrl}
                      >
                        {t("dialog.feed.usePattern")}
                      </button>
                    </div>
                  )}
                </div>
              </details>
            )}

            {/* Direct feed URL input */}
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <Rss size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
              <input
                type="url"
                className="input"
                placeholder={t("dialog.feed.feedUrlPlaceholder")}
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                required
                style={{ flex: 1 }}
              />
              {safeFeedHref && (
                <a href={safeFeedHref} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--xs" title={t("dialog.feed.openFeed")}>
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </fieldset>

          {/* ── Name ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="feed-name">{t("dialog.feed.nameLabel")}</label>
            <input
              id="feed-name"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          {/* ── Description ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="feed-desc">{t("dialog.feed.descriptionLabel")}</label>
            <input
              id="feed-desc"
              type="text"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* ── Schedule ── */}
          <div className="form-group">
            <label className="form-label" htmlFor="feed-cron">{t("dialog.feed.updateScheduleLabel")}</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                id="feed-cron"
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
            <label className="form-label">{t("dialog.feed.maxItemsLabel", { count: maxItemsPerRun })}</label>
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
              id="feed-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor="feed-enabled" className="form-label" style={{ margin: 0 }}>
              {t("dialog.feed.enabledLabel")}
            </label>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            <X size={14} /> {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? <Loader2 size={14} className="spin" /> : null}
            {initial ? t("common.save") : t("dialog.feed.addFeed")}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
