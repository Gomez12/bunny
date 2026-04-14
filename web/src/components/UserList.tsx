import { useEffect, useState } from "react";
import {
  adminCreateUser,
  adminDeleteUser,
  adminResetPassword,
  adminUpdateUser,
  listUsers,
  type AuthUser,
  type UserRole,
} from "../api";

export default function UserList({ currentUserId }: { currentUserId: string }) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [editing, setEditing] = useState<AuthUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = async (search = q) => {
    try {
      setUsers(await listUsers(search));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load users");
    }
  };

  useEffect(() => {
    const h = setTimeout(() => void reload(q), 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const onDelete = async (u: AuthUser) => {
    if (u.id === currentUserId) return;
    if (!confirm(`Delete user "${u.username}"? This removes their sessions and keys.`)) return;
    await adminDeleteUser(u.id);
    await reload();
  };

  return (
    <div className="userlist">
      <h2>Users</h2>
      <div className="userlist-toolbar">
        <input
          placeholder="Search by username, name, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button onClick={() => setCreating(true)}>+ New user</button>
      </div>

      {err && <div className="auth-error">{err}</div>}

      <table className="userlist-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.username}</strong>
                {u.mustChangePassword && <span className="badge">pw reset</span>}
              </td>
              <td>{u.displayName ?? <span className="muted">—</span>}</td>
              <td>{u.email ?? <span className="muted">—</span>}</td>
              <td>{u.role}</td>
              <td>{new Date(u.createdAt).toLocaleDateString()}</td>
              <td>
                <button onClick={() => setEditing(u)}>Edit</button>{" "}
                <button
                  onClick={() => onDelete(u)}
                  disabled={u.id === currentUserId}
                  title={u.id === currentUserId ? "You cannot delete yourself" : ""}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: AuthUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<UserRole>(user.role);
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [newPw, setNewPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    try {
      await adminUpdateUser(user.id, {
        role,
        displayName: displayName || null,
        email: email || null,
      });
      if (newPw) await adminResetPassword(user.id, newPw);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit {user.username}</h3>
        <label>
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          <span>Reset password (optional)</span>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="Leave blank to keep current"
          />
        </label>
        {err && <div className="auth-error">{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    try {
      await adminCreateUser({
        username: username.trim(),
        password,
        role,
        displayName: displayName || undefined,
        email: email || undefined,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New user</h3>
        <label>
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          <span>Initial password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label>
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {err && <div className="auth-error">{err}</div>}
        <p className="muted">
          The user will be prompted to change this password at first login.
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={!username || !password}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
