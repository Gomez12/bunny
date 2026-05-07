import { useEffect, useState } from "react";
import {
  createFeedPattern,
  deleteFeedPattern,
  fetchFeedPatterns,
  type FeedPattern,
  type FeedPatternVariable,
} from "../api";
import { Loader2, Plus, Trash2 } from "../lib/icons";

export default function FeedPatternsAdmin() {
  const [patterns, setPatterns] = useState<FeedPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const reload = async () => {
    try {
      setPatterns(await fetchFeedPatterns());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this pattern?")) return;
    try {
      await deleteFeedPattern(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const grouped = patterns.reduce<Record<string, FeedPattern[]>>((acc, p) => {
    (acc[p.site] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <h2 style={{ margin: 0 }}>Feed Patterns</h2>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => setShowAdd((v) => !v)}
        >
          <Plus size={14} /> Add pattern
        </button>
      </div>

      <p style={{ marginBottom: "16px", opacity: 0.7 }}>
        URL templates used in the "New RSS feed" dialog. Built-in patterns (🔒) are
        read-only; custom patterns can be deleted.
      </p>

      {error && <p className="form-error" style={{ marginBottom: "12px" }}>{error}</p>}

      {showAdd && (
        <AddPatternForm
          onCancel={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void reload(); }}
        />
      )}

      {loading ? (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", padding: "16px 0" }}>
          <Loader2 size={16} className="spin" /> Loading…
        </div>
      ) : (
        Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([site, ps]) => (
          <section key={site} style={{ marginBottom: "24px" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: "14px", opacity: 0.8 }}>{site}</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Name</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Pattern</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Variables</th>
                  <th style={{ width: "32px" }} />
                </tr>
              </thead>
              <tbody>
                {ps.map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "6px 8px" }}>
                      {p.isBuiltin && <span title="Built-in" style={{ marginRight: "4px" }}>🔒</span>}
                      {p.name}
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <code style={{ fontSize: "11px", wordBreak: "break-all" }}>{p.pattern}</code>
                    </td>
                    <td style={{ padding: "6px 8px", opacity: 0.7 }}>
                      {p.variables.map((v) => v.name).join(", ") || "—"}
                    </td>
                    <td style={{ padding: "6px 4px", textAlign: "center" }}>
                      {!p.isBuiltin && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--xs"
                          onClick={() => void handleDelete(p.id)}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}

function AddPatternForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [site, setSite] = useState("");
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [variablesRaw, setVariablesRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let variables: FeedPatternVariable[] = [];
    if (variablesRaw.trim()) {
      const names = variablesRaw.split(",").map((s) => s.trim()).filter(Boolean);
      variables = names.map((n) => ({ name: n, label: n }));
    }

    setSubmitting(true);
    try {
      await createFeedPattern({ site, name, pattern, variables });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      style={{
        background: "var(--bg-subtle)",
        borderRadius: "8px",
        padding: "16px",
        marginBottom: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "14px" }}>Add custom pattern</h3>
      {error && <p className="form-error">{error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
        <div>
          <label className="form-label">Site name</label>
          <input type="text" className="input" value={site} onChange={(e) => setSite(e.target.value)} required placeholder="e.g. MyBlog" />
        </div>
        <div>
          <label className="form-label">Pattern name</label>
          <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Posts" />
        </div>
      </div>
      <div>
        <label className="form-label">URL pattern</label>
        <input
          type="text"
          className="input"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          required
          placeholder="https://example.com/{section}/feed.xml"
        />
        <p className="form-hint">Use {"{variable}"} placeholders for user-supplied values.</p>
      </div>
      <div>
        <label className="form-label">Variable names (comma-separated)</label>
        <input
          type="text"
          className="input"
          value={variablesRaw}
          onChange={(e) => setVariablesRaw(e.target.value)}
          placeholder="e.g. section, tag"
        />
      </div>
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="spin" /> : null}
          Save
        </button>
      </div>
    </form>
  );
}
