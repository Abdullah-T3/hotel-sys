import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Button, Field, Input } from "../components/ui";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { AuthShell } from "./Login";

export default function Setup({ onDone }: { onDone: () => void }) {
  const { signIn } = useApp();
  const { t, lang, errorText } = useI18n();
  const [form, setForm] = useState({ hotel_name: "", name: "", username: "admin", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const { confirm: _confirm, ...body } = form;
      // The language chosen here becomes the hotel's default language.
      const { token } = await api.post<{ token: string }>("/v1/setup", { ...body, language: lang });
      signIn(token);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t("setup.title")} subtitle={t("setup.subtitle")}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t("setup.hotelName")} required><Input autoFocus value={form.hotel_name} onChange={set("hotel_name")} required /></Field>
        <Field label={t("setup.yourName")} required><Input value={form.name} onChange={set("name")} required /></Field>
        <Field label={t("login.username")} hint={t("setup.usernameHint")} required>
          <Input value={form.username} onChange={set("username")} pattern="[A-Za-z0-9_.\-]+" required dir="ltr" />
        </Field>
        <Field label={t("login.password")} hint={t("account.passwordHint")} required>
          <Input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set("password")} required dir="ltr" />
        </Field>
        <Field label={t("account.repeatPassword")} error={mismatch ? t("account.mismatch") : undefined} required>
          <Input type="password" autoComplete="new-password" value={form.confirm} onChange={set("confirm")} required dir="ltr" />
        </Field>
        {error && <div role="alert" className="text-sm text-red-600">{error}</div>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={mismatch}
          icon={<Sparkles className="size-4" />}>{t("setup.submit")}</Button>
      </form>
    </AuthShell>
  );
}
