import { useState, type FormEvent } from "react";
import type {
  AuthUser,
  Contact,
  ContactGroup,
  SocialHandle,
} from "../api";
import { fetchContact, refreshContactSoul } from "../api";
import LanguageTabs, { translationStatusToPill } from "./LanguageTabs";
import StatusPill, { type PillStatus, soulStatusToPill } from "./StatusPill";
import { SOCIAL_PLATFORMS } from "../lib/socials";
import { useTranslations } from "../hooks/useTranslations";

export interface ContactDialogValue {
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  title: string;
  notes: string;
  avatar: string | null;
  tags: string[];
  socials: SocialHandle[];
  groups: number[];
}

interface Props {
  mode: "create" | "edit";
  initial?: Contact;
  allGroups: ContactGroup[];
  /** Required for the translations panel — omitted on create since the
   *  contact doesn't exist yet. */
  currentUser?: AuthUser;
  onClose: () => void;
  onSubmit: (value: ContactDialogValue) => Promise<void>;
}

export default function ContactDialog({
  mode,
  initial,
  allGroups,
  currentUser,
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [emails, setEmails] = useState<string[]>(initial?.emails?.length ? initial.emails : [""]);
  const [phones, setPhones] = useState<string[]>(initial?.phones?.length ? initial.phones : [""]);
  const [company, setCompany] = useState(initial?.company ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [avatar, setAvatar] = useState<string | null>(initial?.avatar ?? null);
  const [tagsStr, setTagsStr] = useState((initial?.tags ?? []).join(", "));
  const [socials, setSocials] = useState<SocialHandle[]>(
    initial?.socials?.length ? initial.socials : [],
  );
  const [groups, setGroups] = useState<Set<number>>(new Set(initial?.groups ?? []));
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        emails: emails.map((e) => e.trim()).filter(Boolean),
        phones: phones.map((p) => p.trim()).filter(Boolean),
        company: company.trim(),
        title: title.trim(),
        notes,
        avatar,
        tags: tagsStr
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        socials: socials
          .map((s) => ({
            platform: s.platform,
            handle: s.handle.trim(),
            ...(s.url?.trim() ? { url: s.url.trim() } : {}),
          }))
          .filter((s) => s.handle || s.url),
        groups: [...groups],
      });
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarFile = (file: File) => {
    if (file.size > 200 * 1024) {
      alert("Avatar must be under 200KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(reader.result as string);
    reader.readAsDataURL(file);
  };

  const updateList = (list: string[], idx: number, value: string, setter: (v: string[]) => void) => {
    const next = [...list];
    next[idx] = value;
    setter(next);
  };

  const addToList = (list: string[], setter: (v: string[]) => void) => {
    setter([...list, ""]);
  };

  const removeFromList = (list: string[], idx: number, setter: (v: string[]) => void) => {
    if (list.length <= 1) {
      setter([""]);
      return;
    }
    setter(list.filter((_, i) => i !== idx));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
      >
        <form className="project-form" onSubmit={handleSubmit}>
          <h2>{mode === "create" ? "New Contact" : "Edit Contact"}</h2>

          <label className="project-form__field">
            Name *
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </label>

          <div className="project-form__field">
            Emails
            {emails.map((email, i) => (
              <div key={i} className="contact-form__multi-row">
                <input
                  type="email"
                  value={email}
                  placeholder="email@example.com"
                  onChange={(e) => updateList(emails, i, e.target.value, setEmails)}
                />
                <button
                  type="button"
                  className="contact-form__remove-btn"
                  onClick={() => removeFromList(emails, i, setEmails)}
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="contact-form__add-btn"
              onClick={() => addToList(emails, setEmails)}
            >
              + Add email
            </button>
          </div>

          <div className="project-form__field">
            Phones
            {phones.map((phone, i) => (
              <div key={i} className="contact-form__multi-row">
                <input
                  type="tel"
                  value={phone}
                  placeholder="+31 6 12345678"
                  onChange={(e) => updateList(phones, i, e.target.value, setPhones)}
                />
                <button
                  type="button"
                  className="contact-form__remove-btn"
                  onClick={() => removeFromList(phones, i, setPhones)}
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="contact-form__add-btn"
              onClick={() => addToList(phones, setPhones)}
            >
              + Add phone
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label className="project-form__field">
              Company
              <input value={company} onChange={(e) => setCompany(e.target.value)} />
            </label>
            <label className="project-form__field">
              Title / Role
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>

          <NotesField
            mode={mode}
            initial={initial}
            currentUser={currentUser}
            notes={notes}
            setNotes={setNotes}
          />

          <label className="project-form__field">
            Tags (comma-separated)
            <input
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="client, vip, partner"
            />
          </label>

          <div className="project-form__field">
            Social profiles
            {socials.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 6 }}>
                Add public handles or URLs so the auto-refresh can summarise what
                this contact is currently up to.
              </div>
            )}
            {socials.map((s, i) => (
              <div key={i} className="contact-form__multi-row">
                <select
                  value={s.platform}
                  onChange={(e) => {
                    const next = [...socials];
                    next[i] = { ...next[i]!, platform: e.target.value };
                    setSocials(next);
                  }}
                  style={{ minWidth: 110 }}
                >
                  {SOCIAL_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  value={s.handle}
                  placeholder={s.platform === "website" ? "https://..." : "@handle or URL"}
                  onChange={(e) => {
                    const next = [...socials];
                    next[i] = { ...next[i]!, handle: e.target.value };
                    setSocials(next);
                  }}
                />
                <button
                  type="button"
                  className="contact-form__remove-btn"
                  onClick={() =>
                    setSocials(socials.filter((_, idx) => idx !== i))
                  }
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="contact-form__add-btn"
              onClick={() =>
                setSocials([...socials, { platform: "twitter", handle: "" }])
              }
            >
              + Add social profile
            </button>
          </div>

          {mode === "edit" && initial && (
            <SoulSection
              initial={initial}
              refreshing={refreshing}
              onStartRefresh={async () => {
                setRefreshing(true);
                try {
                  const res = await refreshContactSoul(initial.project, initial.id);
                  if (!res.ok) {
                    alert(`Refresh failed: HTTP ${res.status}`);
                    return;
                  }
                  // Drain the SSE so the run actually starts on the server.
                  const reader = res.body?.getReader();
                  if (reader) {
                    while (true) {
                      const { done } = await reader.read();
                      if (done) break;
                    }
                  }
                } finally {
                  setRefreshing(false);
                }
              }}
            />
          )}

          {allGroups.length > 0 && (
            <div className="project-form__field">
              Groups
              <div className="contact-form__groups">
                {allGroups.map((g) => (
                  <label key={g.id} className="project-form__chip">
                    <input
                      type="checkbox"
                      checked={groups.has(g.id)}
                      onChange={() => {
                        const next = new Set(groups);
                        if (next.has(g.id)) next.delete(g.id);
                        else next.add(g.id);
                        setGroups(next);
                      }}
                    />
                    <span>
                      {g.color && (
                        <span
                          className="sidebar__group-dot"
                          style={{ background: g.color, marginRight: 4 }}
                        />
                      )}
                      {g.name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="project-form__field">
            Avatar
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {avatar && (
                <img src={avatar} alt="avatar" className="contact-form__avatar-preview" />
              )}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleAvatarFile(file);
                }}
              />
              {avatar && (
                <button type="button" className="contact-form__remove-btn" onClick={() => setAvatar(null)}>
                  &times;
                </button>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--accent" disabled={saving || !name.trim()}>
              {saving ? "Saving..." : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Soul preview + "Refresh now" button. Polls the entity after a refresh so
 * the dialog reflects the new soul without forcing the user to close + reopen.
 */
function SoulSection({
  initial,
  refreshing,
  onStartRefresh,
}: {
  initial: Contact;
  refreshing: boolean;
  onStartRefresh: () => Promise<void>;
}) {
  // We snapshot the initial row, then re-fetch after a successful refresh so
  // the user immediately sees the new soul/status.
  const [current, setCurrent] = useState<Contact>(initial);
  const handleClick = async () => {
    await onStartRefresh();
    try {
      setCurrent(await fetchContact(initial.project, initial.id));
    } catch {
      // non-fatal — list view will catch up on close
    }
  };
  return (
    <div className="project-form__field">
      Soul (auto-refreshed)
      <div className="soul-status-row">
        <StatusPill status={soulStatusToPill(current.soulStatus)} />
        <span>
          {current.soulRefreshedAt
            ? `last refreshed ${new Date(current.soulRefreshedAt).toLocaleString()}`
            : "never refreshed"}
        </span>
        <button
          type="button"
          className="btn soul-status-row__refresh"
          disabled={refreshing || current.soulStatus === "refreshing"}
          onClick={() => void handleClick()}
        >
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>
      <div
        className={`soul-preview${current.soul ? "" : " soul-preview--empty"}`}
      >
        {current.soul || "(empty — will be filled on next refresh)"}
      </div>
      {current.soulError && (
        <div className="lang-readonly__error">{current.soulError}</div>
      )}
    </div>
  );
}

/**
 * Notes field with a language tabstrip. The source-language tab is editable;
 * other project languages render the translated notes read-only with a
 * status pill + "Translate now" button. In create mode, the tabstrip is
 * suppressed entirely — translations land only after the contact is saved.
 */
function NotesField({
  mode,
  initial,
  currentUser,
  notes,
  setNotes,
}: {
  mode: "create" | "edit";
  initial?: Contact;
  currentUser?: AuthUser;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const originalLang = initial?.originalLang ?? null;
  const tr = useTranslations(
    "contact",
    mode === "edit" && initial ? initial.id : null,
    initial?.project ?? "",
    currentUser ?? null,
    originalLang,
  );
  const showTabs =
    mode === "edit" &&
    !!initial &&
    !!originalLang &&
    !!currentUser &&
    tr.languages.length > 1;

  if (!showTabs) {
    return (
      <label className="project-form__field">
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </label>
    );
  }

  const isSourceActive = tr.activeLang === originalLang;
  const t = tr.activeTranslation;
  const pill: PillStatus = t ? translationStatusToPill(t) : "pending";
  const translatedNotes = (t?.fields["notes"] ?? "") as string;

  return (
    <div className="project-form__field">
      <span>Notes</span>
      <LanguageTabs
        languages={tr.languages}
        sourceLang={originalLang!}
        activeLang={tr.activeLang}
        translations={tr.translations}
        onChange={tr.setActiveLang}
      />
      {isSourceActive ? (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Read-only translation — edit the source tab to change the content.
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StatusPill status={pill} />
              <button
                type="button"
                className="btn"
                onClick={() => void tr.translate()}
                disabled={tr.triggering || t?.status === "translating"}
              >
                {tr.triggering ? "Sending…" : "Translate now"}
              </button>
            </div>
          </div>
          <div className="lang-readonly">
            {translatedNotes || (
              <em style={{ color: "var(--text-faint)" }}>Not translated yet.</em>
            )}
          </div>
          {t?.status === "error" && t.error && (
            <div className="lang-readonly__error">{t.error}</div>
          )}
        </>
      )}
    </div>
  );
}
