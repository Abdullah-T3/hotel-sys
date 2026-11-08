import { BedDouble, LogIn } from "lucide-react";
import { useState, type ReactNode } from "react";
import { LanguageSelect } from "../components/LanguageSwitcher";
import { Button, Field, Input } from "../components/ui";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { useApp } from "../lib/app";

export function AuthShell({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="min-h-full flex items-center justify-center p-4 bg-[radial-gradient(ellipse_at_top,var(--primary-soft),transparent_60%)]">
      <div className="absolute top-4 end-4"><LanguageSelect /></div>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6 text-center">
          <div className="rounded-2xl bg-primary p-3 text-white dark:text-gray-950 shadow-lg mb-4"><BedDouble className="size-7" /></div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">{children}</div>
        <p className="text-center text-xs text-muted mt-6">{t("app.name")}</p>
      </div>
    </div>
  );
}

export default function Login({ hotelName }: { hotelName?: string }) {
  const { signIn } = useApp();
  const { t, errorText } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.post<{ token: string }>("/v1/auth/login", { username, password });
      signIn(token);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={hotelName ?? t("login.welcome")} subtitle={t("login.subtitle")}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t("login.username")}>
          <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required dir="ltr" />
        </Field>
        <Field label={t("login.password")}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
        </Field>
        {error && <div role="alert" className="text-sm text-red-600">{error}</div>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="size-4 rtl:-scale-x-100" />}>
          {t("login.signIn")}
        </Button>
      </form>
    </AuthShell>
  );
}
