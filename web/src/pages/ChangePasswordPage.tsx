import { useState } from "react";
import { useTranslation } from "react-i18next";
import { changeOwnPassword, type AuthUser } from "../api";
import Rabbit from "../components/Rabbit";

export default function ChangePasswordPage({
  user,
  onDone,
}: {
  user: AuthUser;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const forced = user.mustChangePassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPw.length < 6) return setError(t("page.changePassword.errorTooShort"));
    if (newPw !== confirmPw) return setError(t("page.changePassword.errorMismatch"));
    setBusy(true);
    setError(null);
    try {
      await changeOwnPassword(currentPw, newPw);
      onDone();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("page.changePassword.errorFallback"),
      );
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
        <h1>
          {forced
            ? t("page.changePassword.titleForced")
            : t("page.changePassword.titleVoluntary")}
        </h1>
        {forced && (
          <p className="auth-note">{t("page.changePassword.forcedNote")}</p>
        )}
        {!forced && (
          <label>
            <span>{t("page.changePassword.currentPassword")}</span>
            <input
              type="password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              required
            />
          </label>
        )}
        <label>
          <span>{t("page.changePassword.newPassword")}</span>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required />
        </label>
        <label>
          <span>{t("page.changePassword.confirmPassword")}</span>
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy
            ? t("page.changePassword.submitting")
            : t("page.changePassword.submit")}
        </button>
      </form>
    </div>
  );
}
