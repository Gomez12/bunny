import { useState, type ReactNode } from "react";

export interface RegenChainEntry {
  id: number;
  ts: number;
  content: string | null;
}

export interface MessageActions {
  /**
   * Called when the user saves an edit. Promise rejection rolls the bubble
   * back into edit mode. Required for Edit to be available.
   */
  onSave?: (newContent: string) => Promise<void>;
  /**
   * User-message only. Saves the edit, soft-deletes everything after, then
   * re-runs the agent with the edited prompt.
   */
  onSaveAndRegenerate?: (newContent: string) => Promise<void>;
  /**
   * Fork the session up to and including this message into a new Quick Chat.
   * The optional `editedContent` is set when the user edits before forking
   * (so the fork lands with the new content as its tail).
   */
  onFork?: (editedContent?: string) => Promise<void>;
  /** Assistant-only: produce an alternate version. */
  onRegenerate?: () => Promise<void>;
}

interface Props {
  role: "user" | "assistant" | "tool" | "system";
  children: ReactNode;
  timestamp?: number;
  /** Agent name — when set, the bubble shows @name instead of "assistant". */
  author?: string | null;
  /**
   * The textual content backing this bubble. Required when actions are wired
   * (powers the inline edit textarea); ignored otherwise.
   */
  rawContent?: string;
  /** True iff the persisted row has been edited at least once. */
  edited?: boolean;
  /** Action callbacks. The bubble enables only the actions whose callback is set. */
  actions?: MessageActions;
  /**
   * For assistant bubbles only. When the chain has more than one entry,
   * renders a `< n/m >` navigator. The active version is `selectedIndex`.
   */
  regenChain?: RegenChainEntry[];
  selectedIndex?: number;
  onSelectIndex?: (idx: number) => void;
}

export default function MessageBubble({
  role,
  children,
  timestamp,
  author,
  rawContent,
  edited,
  actions,
  regenChain,
  selectedIndex,
  onSelectIndex,
}: Props) {
  const label = role === "assistant" && author ? `@${author}` : role;
  const agentClass = role === "assistant" && author ? " bubble--agent" : "";
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const canEdit = Boolean(actions?.onSave) && rawContent !== undefined;
  const canFork = Boolean(actions?.onFork);
  const canRegenerate = Boolean(actions?.onRegenerate) && role === "assistant";
  const canSaveAndRegen =
    Boolean(actions?.onSaveAndRegenerate) && role === "user";

  const startEdit = () => {
    setDraft(rawContent ?? "");
    setIsEditing(true);
  };
  const cancelEdit = () => {
    setIsEditing(false);
    setDraft("");
  };
  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setIsEditing(false);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const showNav = role === "assistant" && (regenChain?.length ?? 0) > 1;
  const total = regenChain?.length ?? 0;
  const active = selectedIndex ?? Math.max(0, total - 1);

  const editingClass = isEditing ? " bubble--editing" : "";

  return (
    <div className={`bubble bubble--${role}${agentClass}${editingClass}`}>
      <div className="bubble__role">
        {label}
        {edited && <span className="bubble__edited-tag">(edited)</span>}
        {showNav && (
          <span className="bubble__regen-nav" aria-label="Regenerated versions">
            <button
              type="button"
              disabled={active === 0 || !onSelectIndex}
              onClick={() => onSelectIndex?.(Math.max(0, active - 1))}
              title="Previous version"
            >
              ‹
            </button>
            <span>
              {active + 1}/{total}
            </span>
            <button
              type="button"
              disabled={active === total - 1 || !onSelectIndex}
              onClick={() => onSelectIndex?.(Math.min(total - 1, active + 1))}
              title="Next version"
            >
              ›
            </button>
          </span>
        )}
      </div>
      {(canEdit || canFork || canRegenerate) && !isEditing && (
        <div className="bubble__actions">
          {canEdit && (
            <button
              type="button"
              className="bubble__action"
              title="Edit message"
              onClick={startEdit}
            >
              ✎
            </button>
          )}
          {canRegenerate && (
            <button
              type="button"
              className="bubble__action"
              title="Regenerate (keep this version as alternate)"
              disabled={busy}
              onClick={() => wrap(async () => actions!.onRegenerate!())}
            >
              ↻
            </button>
          )}
          {canFork && (
            <button
              type="button"
              className="bubble__action"
              title="Fork into a new Quick Chat"
              disabled={busy}
              onClick={() => wrap(async () => actions!.onFork!())}
            >
              ⑂
            </button>
          )}
        </div>
      )}
      <div className="bubble__body">
        {isEditing ? (
          <div className="bubble__edit">
            <textarea
              className="bubble__edit-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Edit your message…"
              autoFocus
            />
            <div className="bubble__edit-buttons">
              <button
                type="button"
                className="btn btn--send"
                disabled={busy || !draft.trim()}
                onClick={() => wrap(async () => actions!.onSave!(draft))}
              >
                Save
              </button>
              {canSaveAndRegen && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !draft.trim()}
                  onClick={() =>
                    wrap(async () => actions!.onSaveAndRegenerate!(draft))
                  }
                >
                  Save &amp; regenerate
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy || !draft.trim()}
                  onClick={() => wrap(async () => actions!.onFork!(draft))}
                  title="Fork this conversation into a new Quick Chat with the edited message — does not modify the current session"
                >
                  Fork
                </button>
              )}
              <button
                type="button"
                className="bubble__edit-cancel"
                disabled={busy}
                onClick={cancelEdit}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          children
        )}
      </div>
      {timestamp != null && (
        <div className="bubble__ts">{new Date(timestamp).toLocaleString()}</div>
      )}
    </div>
  );
}
