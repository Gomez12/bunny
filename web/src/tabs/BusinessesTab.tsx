import { useCallback, useEffect, useRef, useState } from "react";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import BusinessDialog, {
  type BusinessDialogValue,
} from "../components/BusinessDialog";
import StatusPill, { soulStatusToPill } from "../components/StatusPill";
import { RefreshCw } from "../lib/icons";
import {
  createBusiness,
  deleteBusiness,
  fetchBusinesses,
  refreshBusinessSoul,
  triggerBusinessAutoBuild,
  updateBusiness,
  type AuthUser,
  type Business,
} from "../api";

interface Props {
  project: string;
  currentUser: AuthUser;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; business: Business };

export default function BusinessesTab({ project, currentUser }: Props) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [autoBuildBusy, setAutoBuildBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchBusinesses(project, {
        q: debouncedSearch || undefined,
      });
      setBusinesses(result.businesses);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project, debouncedSearch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canEdit = (b: Business) =>
    currentUser.role === "admin" || b.createdBy === currentUser.id;

  const handleCreate = async (v: BusinessDialogValue) => {
    await createBusiness(project, v);
    await refresh();
  };

  const handleEdit = (target: Business) => async (v: BusinessDialogValue) => {
    await updateBusiness(project, target.id, v);
    await refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteBusiness(project, id);
    await refresh();
    setConfirmDelete(null);
  };

  const handleAutoBuild = async () => {
    setAutoBuildBusy(true);
    try {
      await triggerBusinessAutoBuild(project);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoBuildBusy(false);
    }
  };

  const handleSoulRefresh = async (b: Business) => {
    try {
      const res = await refreshBusinessSoul(project, b.id);
      if (!res.ok) {
        alert(`Refresh failed: HTTP ${res.status}`);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      void (async () => {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        await refresh();
      })();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const initials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2)
      return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <div className="businesses-tab">
      <div className="contacts-tab__main">
        <div className="contacts-tab__search-bar">
          <div className="contacts-tab__search-wrap">
            <span className="contacts-tab__search-icon">&#128269;</span>
            <input
              className="contacts-tab__search"
              type="text"
              placeholder="Search businesses..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="contacts-tab__toolbar">
          <button
            className="contacts-tab__toolbar-btn btn--accent"
            onClick={() => setDialog({ kind: "create" })}
          >
            + New Business
          </button>
          {currentUser.role === "admin" && (
            <button
              className="contacts-tab__toolbar-btn"
              onClick={handleAutoBuild}
              disabled={autoBuildBusy}
              title="Walk every contact and create businesses for unique company / domain combos. Opt-in per project."
            >
              {autoBuildBusy ? "Building…" : "Auto-build from contacts"}
            </button>
          )}
        </div>

        {error && (
          <div className="contacts-tab__error">
            {error}
            <button
              className="contacts-tab__error-close"
              onClick={() => setError(null)}
            >
              &times;
            </button>
          </div>
        )}

        {businesses.length === 0 && !debouncedSearch ? (
          <EmptyState
            title="No businesses yet"
            description="Create one manually, or enable auto-build to derive them from your contacts."
          />
        ) : businesses.length === 0 ? (
          <EmptyState size="sm" title="No businesses match your search." />
        ) : (
          <div className="contacts-grid">
            {businesses.map((b) => (
              <div
                key={b.id}
                className="contact-card"
                onClick={() => setDialog({ kind: "edit", business: b })}
              >
                <div className="contact-card__avatar">
                  {b.logo ? (
                    <img src={b.logo} alt={b.name} />
                  ) : (
                    initials(b.name)
                  )}
                </div>
                <div className="contact-card__name">{b.name}</div>
                {b.domain && (
                  <div className="contact-card__role">{b.domain}</div>
                )}
                <div className="contact-card__info">
                  <div className="contact-card__info-row">
                    <StatusPill status={soulStatusToPill(b.soulStatus)} />
                    {b.soulRefreshedAt && (
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                        {new Date(b.soulRefreshedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {b.website && (
                    <div className="contact-card__info-row">
                      <span className="contact-card__info-icon">&#128279;</span>
                      <span>{b.website.replace(/^https?:\/\//, "")}</span>
                    </div>
                  )}
                  {b.address && (b.address.city || b.address.country) && (
                    <div className="contact-card__info-row">
                      <span className="contact-card__info-icon">&#128205;</span>
                      <span>
                        {[b.address.city, b.address.country]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </div>
                  )}
                  {b.emails[0] && (
                    <div className="contact-card__info-row">
                      <span className="contact-card__info-icon">&#9993;</span>
                      <span>{b.emails[0]}</span>
                    </div>
                  )}
                </div>
                {(b.tags.length > 0 || b.source === "auto_from_contacts") && (
                  <div className="contact-card__tags">
                    {b.source === "auto_from_contacts" && (
                      <span className="contact-card__tag">auto-built</span>
                    )}
                    {b.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="contact-card__tag">
                        {tag}
                      </span>
                    ))}
                    {b.tags.length > 3 && (
                      <span className="contact-card__tag">
                        +{b.tags.length - 3}
                      </span>
                    )}
                  </div>
                )}
                {canEdit(b) && (
                  <div className="contact-card__actions">
                    <button
                      className="contact-card__action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleSoulRefresh(b);
                      }}
                      disabled={b.soulStatus === "refreshing"}
                      title="Refresh soul now"
                    >
                      <RefreshCw size={12} strokeWidth={1.75} />
                    </button>
                    <button
                      className="contact-card__action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete({ id: b.id, name: b.name });
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

        <div className="businesses-tab__count">
          {businesses.length} business{businesses.length === 1 ? "" : "es"}
        </div>
      </div>

      {dialog.kind === "create" && (
        <BusinessDialog
          mode="create"
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleCreate}
        />
      )}
      {dialog.kind === "edit" && (
        <BusinessDialog
          mode="edit"
          initial={dialog.business}
          onClose={() => setDialog({ kind: "closed" })}
          onSubmit={handleEdit(dialog.business)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          open={true}
          message={`Delete "${confirmDelete.name}"? It will move to Trash. Linked contacts stay; only the affiliation links are dropped.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void handleDelete(confirmDelete.id)}
        />
      )}
    </div>
  );
}

