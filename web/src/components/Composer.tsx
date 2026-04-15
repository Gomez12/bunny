import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  fetchProjectAgents,
  fetchUserDirectory,
  type Agent,
  type DirectoryUser,
} from "../api";

interface Props {
  disabled: boolean;
  onSubmit: (prompt: string) => void;
  onAbort?: () => void;
  streaming: boolean;
  project: string;
}

interface Suggestion {
  kind: "agent" | "user";
  /** Token to insert after the `@` (no spaces). */
  token: string;
  label: string;
  hint?: string;
}

interface MentionState {
  /** Index of the `@` character in `value`. */
  start: number;
  /** Cursor position (end of the partial token). */
  end: number;
  query: string;
}

const MAX_SUGGESTIONS = 8;

/** Find an open `@…` token at the cursor. Triggers anywhere in the input as long
 * as the `@` is at the start or directly after whitespace. */
function detectMention(value: string, caret: number): MentionState | null {
  if (caret === 0) return null;
  // Walk backwards from the caret to find an `@` or a disqualifying char.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]!;
    if (ch === "@") {
      const prev = i === 0 ? "" : value[i - 1]!;
      if (i !== 0 && !/\s/.test(prev)) return null;
      const query = value.slice(i + 1, caret);
      // Bail if the partial token already contains whitespace — user moved on.
      if (/\s/.test(query)) return null;
      return { start: i, end: caret, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export default function Composer({ disabled, streaming, onSubmit, onAbort, project }: Props) {
  const [value, setValue] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Load mentionables once per project. Failures degrade silently — the popup
  // just won't surface that category.
  useEffect(() => {
    let cancelled = false;
    fetchProjectAgents(project)
      .then((a) => !cancelled && setAgents(a))
      .catch(() => !cancelled && setAgents([]));
    fetchUserDirectory()
      .then((u) => !cancelled && setUsers(u))
      .catch(() => !cancelled && setUsers([]));
    return () => {
      cancelled = true;
    };
  }, [project]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(q);
    const agentItems: Suggestion[] = agents
      .filter((a) => !q || match(a.name) || match(a.description))
      .map((a) => ({
        kind: "agent",
        token: a.name,
        label: a.name,
        hint: a.description || "agent",
      }));
    const userItems: Suggestion[] = users
      .filter((u) => !q || match(u.username) || (u.displayName ? match(u.displayName) : false))
      .map((u) => ({
        kind: "user",
        token: u.username,
        label: u.username,
        hint: u.displayName ?? "user",
      }));
    return [...agentItems, ...userItems].slice(0, MAX_SUGGESTIONS);
  }, [mention, agents, users]);

  // Reset highlight when the suggestion list shape changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [mention?.query, suggestions.length]);

  const refreshMention = (next: string, caret: number) => {
    setMention(detectMention(next, caret));
  };

  const send = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
    setMention(null);
    taRef.current?.focus();
  };

  const insertSuggestion = (s: Suggestion) => {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.end);
    const insert = `@${s.token} `;
    const next = before + insert + after;
    const caret = before.length + insert.length;
    setValue(next);
    setMention(null);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertSuggestion(suggestions[activeIdx]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="composer__field">
        <textarea
          ref={taRef}
          className="composer__input"
          placeholder="Message bunny… (Enter to send, Shift+Enter for newline, @ to mention)"
          rows={1}
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            refreshMention(next, e.target.selectionStart ?? next.length);
          }}
          onKeyUp={(e) => {
            // Catch caret moves (arrows, home/end) without re-running on every keystroke twice.
            const el = e.currentTarget;
            refreshMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onClick={(e) => {
            const el = e.currentTarget;
            refreshMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onBlur={() => {
            // Delay so a click on a suggestion can fire first.
            setTimeout(() => setMention(null), 120);
          }}
          onKeyDown={onKey}
          disabled={disabled && !streaming}
        />
        {mention && suggestions.length > 0 && (
          <ul className="mention-popup" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={`${s.kind}:${s.token}`}
                role="option"
                aria-selected={i === activeIdx}
                className={
                  "mention-popup__item" +
                  (i === activeIdx ? " mention-popup__item--active" : "")
                }
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSuggestion(s);
                }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span
                  className={`mention-popup__badge mention-popup__badge--${s.kind}`}
                  title={s.kind}
                >
                  {s.kind === "agent" ? "A" : "U"}
                </span>
                <span className="mention-popup__label">@{s.label}</span>
                {s.hint && <span className="mention-popup__hint">{s.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {streaming ? (
        <button type="button" className="btn btn--stop" onClick={onAbort}>
          <span className="spinner spinner--on-dark" /> Stop
        </button>
      ) : (
        <button type="submit" className="btn btn--send" disabled={!value.trim() || disabled}>
          Send
        </button>
      )}
    </form>
  );
}
