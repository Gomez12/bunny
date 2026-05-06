import { useEffect, useState } from "react";
import type { Script, ScriptVersion } from "../../../api";
import { listScriptVersions, restoreScriptVersion } from "../../../api";
import { formatRelative } from "../../../lib/format";

interface Props {
  script: Script;
  onRestored: (updated: Script) => void;
}

export default function ScriptVersionsView({ script, onRestored }: Props) {
  const [versions, setVersions] = useState<ScriptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ScriptVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    setLoading(true);
    listScriptVersions(script.id)
      .then(({ versions: v }) => {
        setVersions(v);
        setSelected(v[0] ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [script.id]);

  async function handleRestore() {
    if (!selected) return;
    setRestoring(true);
    try {
      const { script: updated } = await restoreScriptVersion(
        script.id,
        selected.id,
      );
      onRestored(updated);
    } catch {
      /* ignore */
    } finally {
      setRestoring(false);
    }
  }

  if (loading) return <div className="loading-state">Loading versions…</div>;

  if (versions.length === 0) {
    return (
      <div className="script-versions">
        <p style={{ padding: "16px", opacity: 0.6 }}>
          No versions yet. Versions are created when you pause editing or blur
          the editor.
        </p>
      </div>
    );
  }

  return (
    <div className="script-versions">
      <div className="script-versions__sidebar">
        <div className="script-versions__title">Version history</div>
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`script-versions__item ${selected?.id === v.id ? "script-versions__item--active" : ""}`}
            onClick={() => setSelected(v)}
          >
            <span className="script-versions__time">
              {formatRelative(v.createdAt)}
            </span>
            <span className="script-versions__preview">
              {v.content.split("\n")[0]?.slice(0, 40)}
            </span>
          </button>
        ))}
      </div>

      <div className="script-versions__content">
        {selected && (
          <>
            <div className="script-versions__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleRestore}
                disabled={restoring}
              >
                {restoring ? "Restoring…" : "Restore this version"}
              </button>
            </div>
            <pre className="script-versions__code">{selected.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}
