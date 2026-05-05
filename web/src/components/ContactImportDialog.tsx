import { useState, useRef, useCallback, type DragEvent } from "react";
import { parseVCards, type ParsedVCard } from "../lib/vcard";
import type { ContactGroup } from "../api";
import Modal from "./Modal";

interface Props {
  allGroups: ContactGroup[];
  onClose: () => void;
  onImport: (contacts: ParsedVCard[], groupIds: number[]) => Promise<void>;
}

export default function ContactImportDialog({
  allGroups,
  onClose,
  onImport,
}: Props) {
  const [parsed, setParsed] = useState<ParsedVCard[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groups, setGroups] = useState<Set<number>>(new Set());
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback((file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const cards = parseVCards(reader.result as string);
        if (cards.length === 0) {
          setError("No contacts found in the file");
          return;
        }
        setParsed(cards);
        setSelected(new Set(cards.map((_, i) => i)));
      } catch {
        setError("Failed to parse vCard file");
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleContactPicker = async () => {
    if (!("contacts" in navigator)) return;
    try {
      const nav = navigator as Navigator & {
        contacts: {
          select: (
            props: string[],
            opts: { multiple: boolean },
          ) => Promise<
            Array<{ name?: string[]; email?: string[]; tel?: string[] }>
          >;
        };
      };
      const results = await nav.contacts.select(["name", "email", "tel"], {
        multiple: true,
      });
      const cards: ParsedVCard[] = results
        .map((r) => ({
          name: r.name?.[0] ?? "",
          emails: r.email ?? [],
          phones: r.tel ?? [],
          company: "",
          title: "",
          notes: "",
          socials: [],
          photo: null,
        }))
        .filter((c) => c.name);
      if (cards.length === 0) {
        setError("No contacts selected");
        return;
      }
      setParsed(cards);
      setSelected(new Set(cards.map((_, i) => i)));
    } catch {
      setError("Contact picker was cancelled or failed");
    }
  };

  const handleImport = async () => {
    const toImport = parsed.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;
    setImporting(true);
    try {
      await onImport(toImport, [...groups]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const toggleAll = () => {
    if (selected.size === parsed.length) setSelected(new Set());
    else setSelected(new Set(parsed.map((_, i) => i)));
  };

  const hasContactPicker =
    typeof navigator !== "undefined" && "contacts" in navigator;

  return (
    <Modal onClose={onClose} size="md">
      <div className="project-form">
        <Modal.Header title="Import Contacts" />

        {parsed.length === 0 ? (
          <>
            <div
              className={`contact-import__dropzone${dragActive ? " contact-import__dropzone--active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>&#128203;</div>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>
                Drop a .vcf file here or click to browse
              </div>
              <div style={{ fontSize: 12 }}>
                Supports vCard files exported from iPhone, Android, or Google
                Contacts
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,.vcard"
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
            {hasContactPicker && (
              <button
                className="btn btn--accent"
                style={{ width: "100%", marginTop: 8 }}
                onClick={handleContactPicker}
              >
                Import from Phone Contacts
              </button>
            )}
          </>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
                {parsed.length} contact{parsed.length !== 1 ? "s" : ""} found
              </span>
              <button
                type="button"
                className="contact-form__add-btn"
                onClick={toggleAll}
              >
                {selected.size === parsed.length
                  ? "Deselect all"
                  : "Select all"}
              </button>
            </div>
            <div className="contact-import__preview">
              <table className="contact-import__preview-table">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Company</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td>{c.name}</td>
                      <td>{c.emails[0] ?? ""}</td>
                      <td>{c.phones[0] ?? ""}</td>
                      <td>{c.company}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {allGroups.length > 0 && (
              <div className="project-form__field">
                <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Add to groups:
                </span>
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
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              className="contact-form__add-btn"
              onClick={() => {
                setParsed([]);
                setSelected(new Set());
              }}
              style={{ alignSelf: "flex-start" }}
            >
              &larr; Choose a different file
            </button>
          </>
        )}

        {error && (
          <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div>
        )}

        <Modal.Footer>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {parsed.length > 0 && (
            <button
              type="button"
              className="btn btn--accent"
              disabled={importing || selected.size === 0}
              onClick={handleImport}
            >
              {importing
                ? "Importing..."
                : `Import ${selected.size} contact${selected.size !== 1 ? "s" : ""}`}
            </button>
          )}
        </Modal.Footer>
      </div>
    </Modal>
  );
}
