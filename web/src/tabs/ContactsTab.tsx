import { useCallback, useEffect, useRef, useState } from "react";
import DocumentComposer from "../components/DocumentComposer";
import ConfirmDialog from "../components/ConfirmDialog";
import { Trash2 } from "../lib/icons";
import ContactDialog, { type ContactDialogValue } from "../components/ContactDialog";
import ContactImportDialog from "../components/ContactImportDialog";
import type { ParsedVCard } from "../lib/vcard";
import {
  fetchContacts,
  fetchContactGroups,
  createContact,
  updateContact,
  deleteContact,
  importContacts,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  editContacts,
  askContacts,
  contactVcfUrl,
  exportContactsVcf,
  type Contact,
  type ContactGroup,
  type AuthUser,
  type ServerEvent,
} from "../api";

interface Props {
  project: string;
  currentUser: AuthUser;
  onOpenInChat: import("../api").OpenInChatFn;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; contact: Contact }
  | { kind: "import" };

export default function ContactsTab({ project, currentUser, onOpenInChat }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [mode, setMode] = useState<"edit" | "question">("edit");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<{ id: number; name: string } | null>(null);
  const editGroupRef = useRef<HTMLInputElement>(null);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search]);

  const refresh = useCallback(async () => {
    try {
      const [contactsResult, groupsList] = await Promise.all([
        fetchContacts(project, {
          q: debouncedSearch || undefined,
          group: activeGroupId ?? undefined,
        }),
        fetchContactGroups(project),
      ]);
      setContacts(contactsResult.contacts);
      setTotal(contactsResult.total);
      setGroups(groupsList);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project, debouncedSearch, activeGroupId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (editingGroupId !== null && editGroupRef.current) editGroupRef.current.focus();
  }, [editingGroupId]);

  const canEdit = (c: Contact) =>
    currentUser.role === "admin" || c.createdBy === currentUser.id;

  // ── Contact CRUD ───────────────────────────────────────────────────────────

  const handleCreate = async (v: ContactDialogValue) => {
    await createContact(project, v);
    await refresh();
  };

  const handleEdit = (target: Contact) => async (v: ContactDialogValue) => {
    await updateContact(project, target.id, v);
    await refresh();
  };

  const handleDelete = async (c: Contact) => {
    try {
      await deleteContact(project, c.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleImport = async (parsed: ParsedVCard[], groupIds: number[]) => {
    const mapped = parsed.map((c) => ({
      name: c.name,
      emails: c.emails,
      phones: c.phones,
      company: c.company,
      title: c.title,
      notes: c.notes,
      avatar: c.photo,
      groups: groupIds,
    }));
    await importContacts(project, mapped);
    await refresh();
  };

  const handleExportAll = async () => {
    const ids = contacts.map((c) => c.id);
    if (ids.length === 0) return;
    try {
      const blob = await exportContactsVcf(project, ids);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "contacts.vcf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Group CRUD ─────────────────────────────────────────────────────────────

  const handleCreateGroup = async () => {
    const name = prompt("Group name:");
    if (!name?.trim()) return;
    const colors = ["#7c5cff", "#ef4444", "#22c55e", "#f59e0b", "#3b82f6", "#ec4899", "#14b8a6"];
    const color = colors[groups.length % colors.length];
    try {
      await createContactGroup(project, { name: name.trim(), color });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRenameGroup = async (id: number) => {
    const trimmed = editGroupName.trim();
    setEditingGroupId(null);
    if (!trimmed) return;
    try {
      await updateContactGroup(project, id, { name: trimmed });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteGroup = (id: number, name: string) => {
    setConfirmDeleteGroup({ id, name });
  };

  const confirmDeleteGroupAction = async () => {
    const g = confirmDeleteGroup;
    setConfirmDeleteGroup(null);
    if (!g) return;
    try {
      await deleteContactGroup(project, g.id);
      if (activeGroupId === g.id) setActiveGroupId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Chat modes ─────────────────────────────────────────────────────────────

  const buildContactsSummary = (): string => {
    if (contacts.length === 0) return "";
    return contacts
      .map((c) => {
        const parts = [c.name];
        if (c.title || c.company) parts.push(`(${[c.title, c.company].filter(Boolean).join(" @ ")})`);
        if (c.emails.length) parts.push(`Email: ${c.emails.join(", ")}`);
        if (c.phones.length) parts.push(`Phone: ${c.phones.join(", ")}`);
        if (c.tags.length) parts.push(`Tags: ${c.tags.join(", ")}`);
        return parts.join(" | ");
      })
      .join("\n");
  };

  const handleSend = async (prompt: string) => {
    setError(null);
    const contactsSummary = buildContactsSummary();

    if (mode === "question") {
      setStreaming(true);
      try {
        const res = await askContacts(project, { prompt, contactsSummary });
        onOpenInChat(res.sessionId, {
          prompt: res.prompt,
          attachments: res.attachments,
          isQuickChat: res.isQuickChat,
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setStreaming(false);
      }
      return;
    }

    setStreaming(true);
    try {
      const res = await editContacts(project, { prompt, contactsSummary });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        setError(err.error ?? `HTTP ${res.status}`);
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { setError("No response body"); setStreaming(false); return; }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;
          try {
            const ev = JSON.parse(raw) as ServerEvent;
            if (ev.type === "error") setError(ev.message);
          } catch {}
        }
      }

      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(false);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  const initials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="contacts-tab">
      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <div className="sidebar">
        <button className="btn btn--accent sidebar__new" onClick={handleCreateGroup}>
          + New Group
        </button>

        <ul className="sidebar__list">
          <li>
            <button
              className={`sidebar__item${activeGroupId === null ? " sidebar__item--active" : ""}`}
              onClick={() => setActiveGroupId(null)}
            >
              <div className="sidebar__group-row">
                <span className="sidebar__item-title">All Contacts</span>
                <span className="sidebar__group-count">{total}</span>
              </div>
            </button>
          </li>

          {groups.map((g) => (
            <li key={g.id}>
              <button
                className={`sidebar__item${activeGroupId === g.id ? " sidebar__item--active" : ""}`}
                onClick={() => setActiveGroupId(g.id)}
              >
                {editingGroupId === g.id ? (
                  <input
                    ref={editGroupRef}
                    className="sidebar__search"
                    value={editGroupName}
                    onChange={(e) => setEditGroupName(e.target.value)}
                    onBlur={() => handleRenameGroup(g.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameGroup(g.id);
                      if (e.key === "Escape") setEditingGroupId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="sidebar__group-row">
                    {g.color && (
                      <span className="sidebar__group-dot" style={{ background: g.color }} />
                    )}
                    <span className="sidebar__item-title">{g.name}</span>
                    <span className="sidebar__group-count">{g.memberCount}</span>
                    <span className="sidebar__group-actions">
                      <button
                        className="sidebar__group-action-btn"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingGroupId(g.id);
                          setEditGroupName(g.name);
                        }}
                      >
                        &#9998;
                      </button>
                      <button
                        className="sidebar__group-action-btn"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteGroup(g.id, g.name);
                        }}
                      >
                        <Trash2 size={12} strokeWidth={1.75} />
                      </button>
                    </span>
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div className="contacts-tab__main">
        <div className="contacts-tab__search-bar">
          <div className="contacts-tab__search-wrap">
            <span className="contacts-tab__search-icon">&#128269;</span>
            <input
              className="contacts-tab__search"
              type="text"
              placeholder="Search contacts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="contacts-tab__toolbar">
          <button
            className="contacts-tab__toolbar-btn contacts-tab__toolbar-btn--primary"
            onClick={() => setDialog({ kind: "create" })}
          >
            + New Contact
          </button>
          <button
            className="contacts-tab__toolbar-btn"
            onClick={() => setDialog({ kind: "import" })}
          >
            Import
          </button>
          {contacts.length > 0 && (
            <button
              className="contacts-tab__toolbar-btn"
              onClick={handleExportAll}
            >
              Export
            </button>
          )}
        </div>

        {error && (
          <div className="contacts-tab__error">
            {error}
            <button className="contacts-tab__error-close" onClick={() => setError(null)}>
              &times;
            </button>
          </div>
        )}

        {contacts.length === 0 && !debouncedSearch && activeGroupId === null ? (
          <div className="contacts-tab__empty">
            <h2>No contacts yet</h2>
            <p>Create your first contact or import from a .vcf file.</p>
          </div>
        ) : contacts.length === 0 ? (
          <div className="contacts-tab__empty">
            <p>No contacts match your search.</p>
          </div>
        ) : (
          <div className="contacts-grid">
            {contacts.map((c) => (
              <div
                key={c.id}
                className="contact-card"
                onClick={() => setDialog({ kind: "edit", contact: c })}
              >
                <div className="contact-card__avatar">
                  {c.avatar ? (
                    <img src={c.avatar} alt={c.name} />
                  ) : (
                    initials(c.name)
                  )}
                </div>
                <div className="contact-card__name">{c.name}</div>
                {(c.title || c.company) && (
                  <div className="contact-card__role">
                    {[c.title, c.company].filter(Boolean).join(" @ ")}
                  </div>
                )}
                <div className="contact-card__info">
                  {c.emails[0] && (
                    <div className="contact-card__info-row">
                      <span className="contact-card__info-icon">&#9993;</span>
                      <span>{c.emails[0]}</span>
                    </div>
                  )}
                  {c.phones[0] && (
                    <div className="contact-card__info-row">
                      <span className="contact-card__info-icon">&#9742;</span>
                      <span>{c.phones[0]}</span>
                    </div>
                  )}
                </div>
                {c.tags.length > 0 && (
                  <div className="contact-card__tags">
                    {c.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="contact-card__tag">{tag}</span>
                    ))}
                    {c.tags.length > 3 && (
                      <span className="contact-card__tag">+{c.tags.length - 3}</span>
                    )}
                  </div>
                )}
                {canEdit(c) && (
                  <div className="contact-card__actions">
                    <button
                      className="contact-card__action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(contactVcfUrl(project, c.id), "_blank");
                      }}
                      title="Download vCard"
                    >
                      &#8615;
                    </button>
                    <button
                      className="contact-card__action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(c);
                      }}
                      title="Delete"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {streaming && (
          <div className="contacts-tab__overlay">
            <span className="spinner" /> Processing...
          </div>
        )}

        <DocumentComposer
          mode={mode}
          onModeChange={setMode}
          onSend={handleSend}
          streaming={streaming}
          editPlaceholder="Ask AI to analyze, organize, or update your contacts..."
          questionPlaceholder="Ask a question about your contacts..."
        />
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────── */}
      {dialog.kind === "create" && (
        <ContactDialog
          mode="create"
          allGroups={groups}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <ContactDialog
          mode="edit"
          initial={dialog.contact}
          allGroups={groups}
          currentUser={currentUser}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleEdit(dialog.contact)}
        />
      )}
      {dialog.kind === "import" && (
        <ContactImportDialog
          allGroups={groups}
          onClose={() => setDialog({ kind: "closed" })}
          onImport={handleImport}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteGroup !== null}
        message={`Delete group "${confirmDeleteGroup?.name}"? Contacts in this group will not be deleted.`}
        confirmLabel="Delete"
        onConfirm={() => void confirmDeleteGroupAction()}
        onCancel={() => setConfirmDeleteGroup(null)}
      />
    </div>
  );
}
