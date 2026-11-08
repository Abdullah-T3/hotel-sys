import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Bell, Check, Copy, KeyRound, Plus, Power, Trash2, Usb } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Dialog, useConfirm } from "../../components/Dialog";
import { Badge, Button, Card, CardHeader, Empty, Field, IconButton, Input, Notice } from "../../components/ui";
import { useI18n } from "../../i18n";
import { api, type Encoder } from "../../lib/api";
import { useApp } from "../../lib/app";
import { fromNow } from "../../lib/format";

function CopyBlock({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative" dir="ltr">
      <pre className="rounded-lg bg-surface-2 border border-line p-3 pr-10 text-xs overflow-x-auto">{text}</pre>
      <IconButton label={t("common.copy")} className="absolute right-1.5 top-1.5" onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}>{copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}</IconButton>
    </div>
  );
}

function agentConfig(id: string, name: string, token: string) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return JSON.stringify({ server_url: `${proto}://${location.host}/agent/ws`, encoder_id: id, token, name, port: 1, dll_dir: "vendor" }, null, 2);
}

export default function Encoders() {
  const { encoders } = useApp();
  const { t, tr, errorText } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ id: "", name: "" });
  const [secret, setSecret] = useState<{ id: string; name: string; token: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["encoders"] });

  const create = useMutation({
    mutationFn: () => api.post<Encoder & { token: string }>("/v1/encoders", form),
    onSuccess: (e) => { setAdding(false); setSecret({ id: e.id, name: e.name, token: e.token }); setForm({ id: "", name: "" }); refresh(); },
  });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); refresh(); } catch (e) { toast.error(errorText(e)); }
  };

  return (
    <Card>
      <CardHeader title={t("encoders.title")} description={t("encoders.intro")}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("encoders.register")}</Button>} />
      {!encoders.length ? (
        <Empty icon={<Usb className="size-6" />} title={t("encoders.none")} description={t("encoders.noneText")} />
      ) : (
        <ul className="divide-y divide-line">
          {encoders.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
              <span className={clsx("size-2.5 rounded-full", e.online ? "bg-emerald-500" : "bg-red-500")} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{e.name} <span className="text-muted font-normal text-sm">· {e.id}</span>
                  {e.mock && <Badge className="ms-2" tone="amber">{t("encoder.mock")}</Badge>}{!e.enabled && <Badge className="ms-2" tone="red">{t("encoders.disabled")}</Badge>}</div>
                <div className="text-xs text-muted">
                  {e.online ? t("encoder.online") : t("encoders.lastSeen", { time: fromNow(e.last_seen) })}
                  {e.host && ` · ${e.host}`}{e.dll_version && ` · ${e.dll_version}`}{e.agent_version && ` · ${t("encoders.agentVersion", { version: e.agent_version })}`}
                </div>
              </div>
              <div className="flex gap-1">
                <IconButton label={t("encoders.testBeep")} disabled={!e.online} onClick={() => act(() => api.post(`/v1/encoders/${e.id}/beep`, { code: 1 }), t("encoders.beeped", { name: e.name }))}><Bell className="size-4" /></IconButton>
                <IconButton label={e.enabled ? t("encoders.disable") : t("encoders.enable")} onClick={() => act(() => api.patch(`/v1/encoders/${e.id}`, { enabled: !e.enabled }), e.enabled ? t("encoders.disabled") : t("encoders.enabled"))}><Power className="size-4" /></IconButton>
                <IconButton label={t("encoders.newToken")} onClick={async () => {
                  if (!(await confirm({ title: t("encoders.confirmToken", { name: e.name }), confirmLabel: t("encoders.newToken"), message: t("encoders.confirmTokenText") }))) return;
                  try { const r = await api.post<{ token: string }>(`/v1/encoders/${e.id}/rotate-token`); setSecret({ id: e.id, name: e.name, token: r.token }); refresh(); }
                  catch (err) { toast.error(errorText(err)); }
                }}><KeyRound className="size-4" /></IconButton>
                <IconButton label={t("common.delete")} onClick={async () => {
                  if (await confirm({ title: t("encoders.confirmDelete", { name: e.name }), danger: true, confirmLabel: t("common.delete") })) act(() => api.del(`/v1/encoders/${e.id}`), t("encoders.deleted"));
                }}><Trash2 className="size-4" /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} title={t("encoders.register")} size="sm" icon={<Usb className="size-5" />}
        footer={<><Button onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.id || !form.name} onClick={() => create.mutate()}>{t("encoders.registerSubmit")}</Button></>}>
        <div className="space-y-3">
          <Field label={t("encoders.id")} hint={t("encoders.idHint")}>
            <Input dir="ltr" value={form.id} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*" onChange={(e) => setForm({ ...form, id: e.target.value })} />
          </Field>
          <Field label={t("common.name")}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("encoders.namePlaceholder")} /></Field>
          {create.isError && <Notice tone="red">{errorText(create.error)}</Notice>}
        </div>
      </Dialog>

      <Dialog open={!!secret} onClose={() => setSecret(null)} title={t("encoders.configTitle")} icon={<KeyRound className="size-5" />}
        description={t("encoders.configOnce")} footer={<Button variant="primary" onClick={() => setSecret(null)}>{t("encoders.saved")}</Button>}>
        {secret && (
          <div className="space-y-3 text-sm">
            <p>{tr("encoders.configSteps", { file: <code dir="ltr">agent\agent.json</code>, folder: <code dir="ltr">agent\vendor\</code>, run: <code dir="ltr">run_agent.bat</code> })}</p>
            <CopyBlock text={agentConfig(secret.id, secret.name, secret.token)} />
            <Notice tone="amber">{t("encoders.tokenWarning", { name: secret.name })}</Notice>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
