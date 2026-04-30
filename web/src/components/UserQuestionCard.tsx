import { useEffect, useMemo, useState } from "react";
import type { PendingUserQuestion } from "../hooks/useSSEChat";

interface Props {
  question: PendingUserQuestion;
  /** Submit the answer to the server. Resolves when the POST succeeds. */
  onSubmit: (answer: string) => Promise<void>;
}

/**
 * Interactive card rendered inside the assistant bubble whenever the LLM
 * calls the `ask_user` tool. Users can:
 *  - pick a suggested option (single- or multi-select)
 *  - edit a suggested option inline before submitting
 *  - type a free-form answer (when `allowCustom`)
 *
 * Once submitted the card flips to a read-only "answered" state and stays
 * visible in the transcript so the conversation reads back cleanly.
 */
export default function UserQuestionCard({ question, onSubmit }: Props) {
  const { options, allowCustom, submittedAnswer } = question;

  // The LLM-supplied `multiSelect` is a hint, not a hard contract. We let the
  // user override it locally via the "Pick multiple" toggle so a single-choice
  // question can be relaxed when the realistic answer is a list (e.g. "which
  // milkshakes?") — and vice versa.
  const [multiSelect, setMultiSelect] = useState<boolean>(question.multiSelect);

  // Inline-edited copies of the supplied options. Keyed by index so the
  // corresponding radio / checkbox stays selected if the user tweaks the
  // text. Initialised from `options` and re-synced if those ever change
  // (they don't for a given card, but the guard is cheap).
  const initialDrafts = useMemo(() => options.slice(), [options]);
  const [drafts, setDrafts] = useState<string[]>(initialDrafts);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState<string>("");
  const [customActive, setCustomActive] = useState<boolean>(
    options.length === 0 && allowCustom,
  );
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(initialDrafts);
  }, [initialDrafts]);

  const disabled = Boolean(submittedAnswer) || busy;
  const showModeToggle = options.length >= 2 && !submittedAnswer;

  function toggleMode() {
    if (disabled) return;
    setMultiSelect((prev) => {
      const next = !prev;
      if (!next) {
        // multi → single: keep at most one selection (the first picked) so
        // the radio invariant holds and `resolveAnswer` doesn't join multi.
        setSelected((current) => {
          if (current.size <= 1) return current;
          const first = Math.min(...current);
          return new Set([first]);
        });
      }
      return next;
    });
  }

  function toggleOption(i: number) {
    if (disabled) return;
    setCustomActive(false);
    setSelected((prev) => {
      if (multiSelect) {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      }
      return new Set([i]);
    });
  }

  function editDraft(i: number, value: string) {
    if (disabled) return;
    setDrafts((prev) => {
      const next = prev.slice();
      next[i] = value;
      return next;
    });
    setSelected((prev) => (multiSelect ? new Set(prev).add(i) : new Set([i])));
    setCustomActive(false);
  }

  function resolveAnswer(): string | null {
    if (customActive) {
      const trimmed = custom.trim();
      return trimmed || null;
    }
    if (selected.size === 0) return null;
    const picked = Array.from(selected)
      .sort((a, b) => a - b)
      .map((i) => drafts[i]?.trim())
      .filter((v): v is string => !!v);
    if (picked.length === 0) return null;
    return picked.join("\n");
  }

  async function handleSubmit() {
    const answer = resolveAnswer();
    if (!answer) {
      setError("Pick an option or type an answer first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit(answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (submittedAnswer) {
    return (
      <div className="askuser askuser--answered">
        <div className="askuser__question">{question.question}</div>
        <div className="askuser__answer">
          <span className="askuser__answer-label">You answered</span>
          <pre className="askuser__answer-text">{submittedAnswer}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="askuser">
      <div className="askuser__header">
        <div className="askuser__question">{question.question}</div>
        {showModeToggle && (
          <label className="askuser__mode-toggle" title="Allow picking more than one option">
            <input
              type="checkbox"
              checked={multiSelect}
              onChange={toggleMode}
              disabled={disabled}
            />
            <span>Pick multiple</span>
          </label>
        )}
      </div>
      {options.length > 0 && (
        <ul className="askuser__options">
          {options.map((_, i) => {
            const isSelected = selected.has(i) && !customActive;
            const inputType = multiSelect ? "checkbox" : "radio";
            return (
              <li
                key={i}
                className={
                  "askuser__option" +
                  (isSelected ? " askuser__option--selected" : "")
                }
              >
                <label className="askuser__option-label">
                  <input
                    type={inputType}
                    name={`askuser-${question.questionId}`}
                    checked={isSelected}
                    onChange={() => toggleOption(i)}
                    disabled={disabled}
                  />
                  <input
                    type="text"
                    className="askuser__option-input"
                    value={drafts[i] ?? ""}
                    onChange={(e) => editDraft(i, e.target.value)}
                    onFocus={() => toggleOption(i)}
                    disabled={disabled}
                    aria-label={`Option ${i + 1}`}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {allowCustom && (
        <div
          className={
            "askuser__custom" +
            (customActive ? " askuser__custom--active" : "")
          }
        >
          <label className="askuser__option-label">
            <input
              type={multiSelect ? "checkbox" : "radio"}
              name={`askuser-${question.questionId}`}
              checked={customActive}
              onChange={() => {
                if (disabled) return;
                setCustomActive(true);
                if (!multiSelect) setSelected(new Set());
              }}
              disabled={disabled}
            />
            <textarea
              className="askuser__custom-input"
              placeholder={
                options.length === 0
                  ? "Type your answer…"
                  : "Or write your own…"
              }
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                if (!customActive) setCustomActive(true);
              }}
              onFocus={() => setCustomActive(true)}
              disabled={disabled}
              rows={2}
            />
          </label>
        </div>
      )}
      {error && <div className="askuser__error">{error}</div>}
      <div className="askuser__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void handleSubmit()}
          disabled={disabled}
        >
          {busy ? "Sending…" : "Send answer"}
        </button>
      </div>
    </div>
  );
}
