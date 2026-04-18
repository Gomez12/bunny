import { useState } from "react";
import { changeOwnPassword, type AuthUser } from "../api";
import Rabbit from "../components/Rabbit";

export default function ChangePasswordPage({
  user,
  onDone,
}: {
  user: AuthUser;
  onDone: () => void;
}) {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const forced = user.mustChangePassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPw.length < 6) return setError("Password must be at least 6 characters");
    if (newPw !== confirmPw) return setError("Passwords do not match");
    setBusy(true);
    setError(null);
    try {
      await changeOwnPassword(currentPw, newPw);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-hero" aria-hidden="true">
          <Rabbit size={160} />
        </div>
        <h1>{forced ? "Set a new password" : "Change your password"}</h1>
        {forced && (
          <p className="auth-note">
            You're signed in with the initial password. Please pick your own before continuing.
          </p>
        )}
        {!forced && (
          <label>
            <span>Current password</span>
            <input
              type="password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              required
            />
          </label>
        )}
        <label>
          <span>New password</span>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required />
        </label>
        <label>
          <span>Confirm new password</span>
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </button>
      </form>
    </div>
  );
}
