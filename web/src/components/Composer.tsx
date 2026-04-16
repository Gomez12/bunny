import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  fetchProjectAgents,
  fetchUserDirectory,
  uploadImageForDataUrl,
  type Agent,
  type ChatAttachment,
  type DirectoryUser,
} from "../api";

interface Props {
  disabled: boolean;
  onSubmit: (prompt: string, attachments: ChatAttachment[]) => void;
  onAbort?: () => void;
  streaming: boolean;
  project: string;
}

export const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024; // raw file; base64 ≈ +33%.

/** Safari occasionally drops File objects with an empty `type` — fall back to
 * the filename extension so we don't reject an otherwise-valid PNG. */
export function resolveImageMime(file: File): string | null {
  if (file.type && ALLOWED_IMAGE_MIME.has(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export interface ComposerHandle {
  /** Add files (images) to the pending attachment list. Used for drop targets
   * outside the composer itself, e.g. the surrounding chat scroll area. */
  addFiles: (files: FileList | File[]) => Promise<void>;
  /** Append an already-read attachment directly. Used by drop handlers that
   * must initiate the File read *synchronously* inside the drop event (Safari
   * invalidates DataTransfer Files once the event handler returns). */
  pushAttachment: (a: ChatAttachment) => void;
  /** Report a validation or read error to the composer's error slot. */
  reportAttachError: (msg: string) => void;
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



const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { disabled, streaming, onSubmit, onAbort, project },
  ref,
) {
  const [value, setValue] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    if (!text && attachments.length === 0) return;
    onSubmit(text, attachments);
    setValue("");
    setAttachments([]);
    setAttachError(null);
    setMention(null);
    taRef.current?.focus();
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachError(null);
    const next: ChatAttachment[] = [];
    for (const f of list) {
      const mime = resolveImageMime(f);
      if (!mime) {
        setAttachError(`'${f.name}': only PNG/JPEG/GIF/WEBP images are supported`);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setAttachError(`'${f.name}' exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
        continue;
      }
      if (attachments.length + next.length >= MAX_IMAGES) {
        setAttachError(`at most ${MAX_IMAGES} images per message`);
        break;
      }
      try {
        const attachment = await uploadImageForDataUrl(f, mime);
        next.push(attachment);
      } catch (err) {
        setAttachError(`failed to read '${f.name}': ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  useImperativeHandle(
    ref,
    () => ({
      addFiles,
      pushAttachment: (a) => setAttachments((prev) => [...prev, a]),
      reportAttachError: (msg) => setAttachError(msg),
    }),
    [addFiles],
  );

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
        {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map((a, i) => (
              <div key={i} className="composer__thumb">
                <img src={a.dataUrl} alt={`attachment ${i + 1}`} />
                <button
                  type="button"
                  className="composer__thumb-remove"
                  aria-label="remove attachment"
                  onClick={() => removeAttachment(i)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {attachError && <div className="composer__attach-error">{attachError}</div>}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
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
          onPaste={(e) => {
            const imgs: File[] = [];
            for (const item of e.clipboardData.items) {
              if (item.kind === "file" && item.type.startsWith("image/")) {
                const f = item.getAsFile();
                if (f) imgs.push(f);
              }
            }
            if (imgs.length > 0) {
              e.preventDefault();
              void addFiles(imgs);
            }
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
      {!streaming && (
        <button
          type="button"
          className="btn btn--attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || attachments.length >= MAX_IMAGES}
          title="Attach image"
          aria-label="Attach image"
        >
          📎
        </button>
      )}
      {streaming ? (
        <button type="button" className="btn btn--stop" onClick={onAbort}>
          <span className="spinner spinner--on-dark" /> Stop
        </button>
      ) : (
        <button
          type="submit"
          className="btn btn--send"
          disabled={(!value.trim() && attachments.length === 0) || disabled}
        >
          Send
        </button>
      )}
    </form>
  );
});

export default Composer;
