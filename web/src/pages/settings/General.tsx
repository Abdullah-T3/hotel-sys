import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button, Card, CardHeader, Field, Input, Notice, Segmented, Select, Spinner, Switch } from "../../components/ui";
import { LANGUAGES, useI18n } from "../../i18n";
import { api, type HotelSettings } from "../../lib/api";
import { LOCK_OPTION_KEYS } from "../LockSetup";

export default function General() {
  const { t, tr, errorText } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<HotelSettings>("/v1/settings") });
  const [s, setS] = useState<HotelSettings | null>(null);
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put<HotelSettings>("/v1/settings", { ...s, co_id: s?.co_id ?? undefined }),
    onSuccess: (d) => { setS(d); toast.success(t("settings.saved")); qc.invalidateQueries({ queryKey: ["meta"] }); qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!s) return <div className="flex justify-center py-16"><Spinner /></div>;
  const set = (p: Partial<HotelSettings>) => setS({ ...s, ...p });
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title={t("settings.hotel")} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("setup.hotelName")}><Input value={s.hotel_name} onChange={(e) => set({ hotel_name: e.target.value })} /></Field>
          <Field label={t("settings.currency")} hint={t("settings.currencyHint")}><Input value={s.currency} maxLength={8} onChange={(e) => set({ currency: e.target.value })} /></Field>
          <Field label={t("settings.checkoutTime")}><Input type="time" value={s.checkout_time} onChange={(e) => set({ checkout_time: e.target.value })} /></Field>
          <Field label={t("settings.vipCheckoutTime")}><Input type="time" value={s.vip_checkout_time} onChange={(e) => set({ vip_checkout_time: e.target.value })} /></Field>
          <Field label={t("settings.afterCheckout")} group>
            <Segmented value={s.after_checkout} onChange={(v) => set({ after_checkout: v })}
              options={[{ value: "dirty", label: t("settings.afterDirty") }, { value: "clean", label: t("settings.afterClean") }]} />
          </Field>
          <Field label={t("settings.defaultLanguage")} hint={t("settings.defaultLanguageHint")}>
            <Select value={s.default_language} onChange={(e) => set({ default_language: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label={t("settings.coId")} hint={t("settings.coIdHint")}>
            <Input type="number" min={0} value={s.co_id ?? ""} onChange={(e) => set({ co_id: e.target.value === "" ? null : Number(e.target.value) })} />
          </Field>
        </div>
      </Card>
      <Card>
        <CardHeader title={t("settings.lockBehaviour")} description={t("settings.lockBehaviourText")} />
        <div className="px-5 py-2 divide-y divide-line">
          <Switch checked={s.guest_opens_deadbolt} onChange={(v) => set({ guest_opens_deadbolt: v })}
            label={t("lockOption.guest_deadbolt.label")} description={t("lockOption.guest_deadbolt.text")} />
          {LOCK_OPTION_KEYS.map((k) => (
            <Switch key={k} checked={s.lock_options[k]} label={t(`lockOption.${k}.label`)} description={t(`lockOption.${k}.text`)}
              onChange={(v) => set({ lock_options: { ...s.lock_options, [k]: v } })} />
          ))}
        </div>
        <div className="px-5 pb-4">
          <Notice tone="blue">{tr("settings.issueSystemCard", { link: <Link to="/lock-setup" className="underline font-medium">{t("cardKind.system")}</Link> })}</Notice>
        </div>
      </Card>
      <div className="sticky bottom-4 flex justify-end">
        <Button variant="primary" size="lg" icon={<Save className="size-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>{t("settings.save")}</Button>
      </div>
    </div>
  );
}
