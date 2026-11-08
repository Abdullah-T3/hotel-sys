import { KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { Dialog } from "./Dialog";
import { Button, Field, Input } from "./ui";

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, errorText } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/auth/password", { current_password: current, new_password: next });
      toast.success(t("account.passwordChanged"));
      setCurrent(""); setNext(""); setConfirm("");
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("account.changePassword")} icon={<KeyRound className="size-5" />} size="sm">
      <form onSubmit={submit} className="space-y-3">
        <Field label={t("account.currentPassword")} required>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label={t("account.newPassword")} hint={t("account.passwordHint")} required>
          <Input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label={t("account.repeatPassword")} error={mismatch ? t("account.mismatch") : undefined} required>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={mismatch || next.length < 8}>{t("account.changePassword")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
