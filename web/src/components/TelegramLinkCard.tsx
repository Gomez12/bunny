import { useEffect, useState } from "react";
import {
  createPendingTelegramLink,
  deleteTelegramLinkFor,
  fetchProjects,
  listMyTelegramLinks,
  type PendingLinkDto,
  type Project,
  type TelegramLinkDto,
} from "../api";
import { Copy, LinkIcon, Send, Trash2 } from "../lib/icons";

/**
 * Profile card that lists a user's per-project Telegram links and lets them
 * generate a one-time pairing token. Intended to be rendered inside the
 * Settings → Profile tab next to the password form.
 */
export default function TelegramLinkCard() {
  const [links, setLinks] = useState<TelegramLinkDto[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLinkDto | null>(null);
  const [pickProject, setPickProject] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listMyTelegramLinks(), fetchProjects()])
      .then(([l, p]) => {
        if (cancelled) return;
        setLinks(l);
        setProjects(p);
      })
      .catch((e: Error) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const existingProjects = new Set(links.map((l) => l.project));
  const availableProjects = projects
    .map((p) => p.name)
    .filter((n) => !existingProjects.has(n));

  const generate = async () => {
    if (!pickProject) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await createPendingTelegramLink(pickProject);
      setPending(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (project: string) => {
    if (!confirm(`Unlink Telegram for project "${project}"?`)) return;
    try {
      await deleteTelegramLinkFor(project);
      setLinks((prev) => prev.filter((l) => l.project !== project));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return null;

  return (
    <div className="telegram-link-card">
      <h2>
        <Send size={18} strokeWidth={1.75} /> Telegram links
      </h2>
      <p className="muted">
        Link a Telegram chat to your Bunny account per project. You'll get
        notifications, card-run results, and news digests in Telegram, plus be
        able to chat with the project's agent from your phone.
      </p>

      {links.length === 0 ? (
        <p className="muted">No active links yet.</p>
      ) : (
        <ul className="telegram-link-card__list">
          {links.map((l) => (
            <li key={l.project}>
              <span className="telegram-link-card__project">
                <strong>{l.project}</strong>
                <span className="muted">
                  {" "}
                  — chat {l.chatIdMasked}
                  {l.tgUsername ? ` · @${l.tgUsername}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--icon"
                onClick={() => unlink(l.project)}
                title="Unlink"
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {availableProjects.length > 0 ? (
        <div className="telegram-link-card__generate">
          <label>
            <span>Create a new link</span>
            <select
              value={pickProject}
              onChange={(e) => setPickProject(e.target.value)}
            >
              <option value="">Select a project…</option>
              {availableProjects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={generate}
            disabled={busy || !pickProject}
          >
            <LinkIcon size={16} strokeWidth={1.75} /> Generate token
          </button>
        </div>
      ) : (
        <p className="muted">
          All your projects are linked. Disconnect one above to re-link with a
          different chat.
        </p>
      )}

      {pending && (
        <div className="telegram-link-card__pending">
          <p>
            <strong>Link ready.</strong> Open this link in Telegram and send{" "}
            <code>/start {pending.token}</code> to <code>@{pending.botUsername}</code>:
          </p>
          <div className="telegram-link-card__deeplink">
            <a href={pending.deepLink} target="_blank" rel="noreferrer">
              {pending.deepLink}
            </a>
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => navigator.clipboard.writeText(pending.deepLink)}
              title="Copy link"
            >
              <Copy size={16} strokeWidth={1.75} />
            </button>
          </div>
          <p className="muted">
            Expires in{" "}
            {Math.max(
              0,
              Math.round((pending.expiresAt - Date.now()) / 60_000),
            )}{" "}
            minutes.
          </p>
        </div>
      )}

      {err && <p className="error">{err}</p>}
    </div>
  );
}
