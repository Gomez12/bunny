import { useEffect, useState } from "react";
import { createMyApiKey, listMyApiKeys, revokeMyApiKey, type ApiKeyMeta } from "../api";
import ConfirmDialog from "./ConfirmDialog";

export default function ApiKeyList() {
  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  // Creation form
  const [name, setName] = useState("");
  const [ttlDays, setTtlDays] = useState<string>("");

  const reload = async () => {
    setLoading(true);
    try {
      setKeys(await listMyApiKeys());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const ttl = ttlDays ? Number(ttlDays) : undefined;
      const { key } = await createMyApiKey(name.trim(), { ttlDays: ttl });
      setFreshSecret(key);
      setName("");
      setTtlDays("");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create key");
    }
  };

  const revoke = (id: string) => {
    setConfirmRevokeId(id);
  };

  const confirmRevokeAction = async () => {
    const id = confirmRevokeId;
    setConfirmRevokeId(null);
    if (!id) return;
    await revokeMyApiKey(id);
    await reload();
  };

  return (
    <div className="apikeys">
      <h2>API keys</h2>
      <p className="muted">
        Use API keys to authenticate the CLI:{" "}
        <code>BUNNY_API_KEY=&lt;key&gt; bun run src/index.ts "…"</code>
      </p>

      <form onSubmit={create} className="apikey-form">
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="laptop-cli"
            required
          />
        </label>
        <label>
          <span>Valid for (days, optional)</span>
          <input
            type="number"
            min={1}
            value={ttlDays}
            onChange={(e) => setTtlDays(e.target.value)}
            placeholder="never expires"
          />
        </label>
        <button type="submit" disabled={!name.trim()}>
          Create key
        </button>
      </form>

      {freshSecret && (
        <div className="apikey-fresh">
          <strong>Copy this key now — it won't be shown again:</strong>
          <code>{freshSecret}</code>
          <button onClick={() => setFreshSecret(null)}>Done</button>
        </div>
      )}

      {err && <div className="auth-error">{err}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : keys.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <table className="apikey-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className={k.revokedAt ? "revoked" : ""}>
                <td>{k.name}</td>
                <td>
                  <code>bny_{k.prefix}…</code>
                </td>
                <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "—"}</td>
                <td>
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : <span className="muted">never</span>}
                </td>
                <td>
                  {k.revokedAt ? (
                    <span className="muted">revoked</span>
                  ) : (
                    <button onClick={() => revoke(k.id)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={confirmRevokeId !== null}
        message="Revoke this API key? Clients using it will lose access."
        confirmLabel="Revoke"
        onConfirm={() => void confirmRevokeAction()}
        onCancel={() => setConfirmRevokeId(null)}
      />
    </div>
  );
}
