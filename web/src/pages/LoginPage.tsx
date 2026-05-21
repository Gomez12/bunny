import { useState } from "react";
import { useTranslation } from "react-i18next";
import { login, type AuthUser } from "../api";
import Rabbit from "../components/Rabbit";

export default function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username, password);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("page.login.errorFallback"));
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
        <h1>{t("page.login.title")}</h1>
        <label>
          <span>{t("page.login.username")}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          <span>{t("page.login.password")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? t("page.login.submitting") : t("page.login.submit")}
        </button>
      </form>
    </div>
  );
}
