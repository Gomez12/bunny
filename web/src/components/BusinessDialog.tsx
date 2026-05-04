import { useState, type FormEvent } from "react";
import StatusPill, { soulStatusToPill } from "./StatusPill";
import { SOCIAL_PLATFORMS } from "../lib/socials";
import {
  fetchBusiness,
  refreshBusinessSoul,
  type Business,
  type BusinessAddress,
  type SocialHandle,
} from "../api";

export interface BusinessDialogValue {
  name: string;
  domain: string | null;
  description: string;
  notes: string;
  website: string | null;
  emails: string[];
  phones: string[];
  socials: SocialHandle[];
  address: BusinessAddress | null;
  logo: string | null;
  tags: string[];
}

interface Props {
  mode: "create" | "edit";
  initial?: Business;
  onClose: () => void;
  onSubmit: (value: BusinessDialogValue) => Promise<void>;
}

export default function BusinessDialog({ mode, initial, onClose, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [website, setWebsite] = useState(initial?.website ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [emails, setEmails] = useState<string[]>(
    initial?.emails?.length ? initial.emails : [""],
  );
  const [phones, setPhones] = useState<string[]>(
    initial?.phones?.length ? initial.phones : [""],
  );
  const [socials, setSocials] = useState<SocialHandle[]>(
    initial?.socials?.length ? initial.socials : [],
  );
  const [tagsStr, setTagsStr] = useState((initial?.tags ?? []).join(", "));
  const [logo, setLogo] = useState<string | null>(initial?.logo ?? null);
  const [street, setStreet] = useState(initial?.address?.street ?? "");
  const [postalCode, setPostalCode] = useState(initial?.address?.postalCode ?? "");
  const [city, setCity] = useState(initial?.address?.city ?? "");
  const [region, setRegion] = useState(initial?.address?.region ?? "");
  const [country, setCountry] = useState(initial?.address?.country ?? "");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const addressFields: BusinessAddress = {};
    if (street.trim()) addressFields.street = street.trim();
    if (postalCode.trim()) addressFields.postalCode = postalCode.trim();
    if (city.trim()) addressFields.city = city.trim();
    if (region.trim()) addressFields.region = region.trim();
    if (country.trim()) addressFields.country = country.trim();
    const address = Object.keys(addressFields).length > 0 ? addressFields : null;
    try {
      await onSubmit({
        name: name.trim(),
        domain: domain.trim() ? domain.trim() : null,
        description,
        notes,
        website: website.trim() ? website.trim() : null,
        emails: emails.map((e) => e.trim()).filter(Boolean),
        phones: phones.map((p) => p.trim()).filter(Boolean),
        socials: socials
          .map((s) => ({
            platform: s.platform,
            handle: s.handle.trim(),
            ...(s.url?.trim() ? { url: s.url.trim() } : {}),
          }))
          .filter((s) => s.handle || s.url),
        address,
        logo,
        tags: tagsStr
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleLogoFile = (file: File) => {
    if (file.size > 200 * 1024) {
      alert("Logo must be under 200KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(reader.result as string);
    reader.readAsDataURL(file);
  };

  const updateList = (list: string[], idx: number, value: string, setter: (v: string[]) => void) => {
    const next = [...list];
    next[idx] = value;
    setter(next);
  };
  const addToList = (list: string[], setter: (v: string[]) => void) => setter([...list, ""]);
  const removeFromList = (list: string[], idx: number, setter: (v: string[]) => void) => {
    if (list.length <= 1) {
      setter([""]);
      return;
    }
    setter(list.filter((_, i) => i !== idx));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <form className="project-form" onSubmit={handleSubmit}>
          <h2>{mode === "create" ? "New Business" : "Edit Business"}</h2>

          <label className="project-form__field">
            Name *
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label className="project-form__field">
              Domain
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
              />
            </label>
            <label className="project-form__field">
              Website
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://acme.com"
              />
            </label>
          </div>

          <label className="project-form__field">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </label>

          <label className="project-form__field">
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </label>

          <div className="project-form__field">
            Emails
            {emails.map((email, i) => (
              <div key={i} className="contact-form__multi-row">
                <input
                  type="email"
                  value={email}
                  placeholder="info@acme.com"
                  onChange={(e) => updateList(emails, i, e.target.value, setEmails)}
                />
                <button
                  type="button"
                  className="contact-form__remove-btn"
                  onClick={() => removeFromList(emails, i, setEmails)}
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
                  onChange={(e) => updateList(phones, i, e.target.value, setPhones)}
                />
                <button
                  type="button"
                  className="contact-form__remove-btn"
                  onClick={() => removeFromList(phones, i, setPhones)}
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

          <div className="project-form__field">
            <span className="soul-status-row">
              <span>Address</span>
              {initial?.addressFetchedAt && (
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  auto-filled {new Date(initial.addressFetchedAt).toLocaleDateString()}
                </span>
              )}
            </span>
            <input
              value={street}
              placeholder="Street + number"
              onChange={(e) => setStreet(e.target.value)}
            />
            <div className="business-form__address-row business-form__address-row--zip-city">
              <input
                value={postalCode}
                placeholder="Postal code"
                onChange={(e) => setPostalCode(e.target.value)}
              />
              <input
                value={city}
                placeholder="City"
                onChange={(e) => setCity(e.target.value)}
              />
            </div>
            <div className="business-form__address-row business-form__address-row--region-country">
              <input
                value={region}
                placeholder="Region / state (optional)"
                onChange={(e) => setRegion(e.target.value)}
              />
              <input
                value={country}
                placeholder="Country (NL, DE, …)"
                onChange={(e) => setCountry(e.target.value)}
              />
            </div>
            <span className="project-form__hint" style={{ marginTop: 6 }}>
              Filled automatically by the soul-refresh handler from the
              business website's contact / imprint page. Manual edits override
              the auto-fill until the next refresh.
            </span>
          </div>

          <div className="project-form__field">
            Social profiles
            {socials.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 6 }}>
                Add public handles or URLs so the auto-refresh can summarise what
                this business is currently up to.
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
                  onClick={() => setSocials(socials.filter((_, idx) => idx !== i))}
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="contact-form__add-btn"
              onClick={() =>
                setSocials([...socials, { platform: "linkedin", handle: "" }])
              }
            >
              + Add social profile
            </button>
          </div>

          <label className="project-form__field">
            Tags (comma-separated)
            <input
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="vendor, partner, prospect"
            />
          </label>

          <div className="project-form__field">
            Logo
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {logo && (
                <img src={logo} alt="logo" className="contact-form__avatar-preview" />
              )}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleLogoFile(file);
                }}
              />
              {logo && (
                <button
                  type="button"
                  className="contact-form__remove-btn"
                  onClick={() => setLogo(null)}
                >
                  &times;
                </button>
              )}
            </div>
          </div>

          {mode === "edit" && initial && (
            <SoulSection
              initial={initial}
              refreshing={refreshing}
              onStartRefresh={async () => {
                setRefreshing(true);
                try {
                  const res = await refreshBusinessSoul(
                    initial.project,
                    initial.id,
                  );
                  if (!res.ok) {
                    alert(`Refresh failed: HTTP ${res.status}`);
                    return;
                  }
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

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--accent"
              disabled={saving || !name.trim()}
            >
              {saving ? "Saving..." : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SoulSection({
  initial,
  refreshing,
  onStartRefresh,
}: {
  initial: Business;
  refreshing: boolean;
  onStartRefresh: () => Promise<void>;
}) {
  const [current, setCurrent] = useState<Business>(initial);
  const handleClick = async () => {
    await onStartRefresh();
    try {
      setCurrent(await fetchBusiness(initial.project, initial.id));
    } catch {
      /* non-fatal — list view will catch up on close */
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
