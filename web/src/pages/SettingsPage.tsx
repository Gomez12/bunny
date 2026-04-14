import { useEffect, useState } from "react";
import type { AuthUser } from "../api";
import { updateOwnProfile, changeOwnPassword } from "../api";
import ApiKeyList from "../components/ApiKeyList";
import UserList from "../components/UserList";

type Tab = "profile" | "keys" | "users";

export default function SettingsPage({
  user,
  onUserUpdated,
}: {
  user: AuthUser;
  onUserUpdated: (u: AuthUser) => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");

  return (
    <div className="settings">
      <nav className="settings-nav">
        <button
          className={tab === "profile" ? "active" : ""}
          onClick={() => setTab("profile")}
        >
          Profile
        </button>
        <button className={tab === "keys" ? "active" : ""} onClick={() => setTab("keys")}>
          API keys
        </button>
        {user.role === "admin" && (
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            Users
          </button>
        )}
      </nav>
      <section className="settings-body">
        {tab === "profile" && <ProfileForm user={user} onUpdated={onUserUpdated} />}
        {tab === "keys" && <ApiKeyList />}
        {tab === "users" && user.role === "admin" && <UserList currentUserId={user.id} />}
      </section>
    </div>
  );
}

function ProfileForm({ user, onUpdated }: { user: AuthUser; onUpdated: (u: AuthUser) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user.displayName ?? "");
    setEmail(user.email ?? "");
  }, [user]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      const u = await updateOwnProfile({
        displayName: displayName || null,
        email: email || null,
      });
      onUpdated(u);
      setMsg("Profile saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  };

  const submitPw = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      await changeOwnPassword(currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setMsg("Password updated.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change password");
    }
  };

  return (
    <div className="profile">
      <form onSubmit={save}>
        <h2>Profile</h2>
        <div className="read-only">
          <div>
            <span className="muted">Username</span>
            <span>{user.username}</span>
          </div>
          <div>
            <span className="muted">Role</span>
            <span>{user.role}</span>
          </div>
        </div>
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit">Save profile</button>
      </form>

      <form onSubmit={submitPw}>
        <h2>Password</h2>
        <label>
          <span>Current password</span>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            required
          />
        </label>
        <label>
          <span>New password</span>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            required
          />
        </label>
        <button type="submit">Change password</button>
      </form>

      {msg && <div className="auth-ok">{msg}</div>}
      {err && <div className="auth-error">{err}</div>}
    </div>
  );
}
