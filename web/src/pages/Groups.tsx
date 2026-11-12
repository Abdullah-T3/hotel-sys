import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarPlus, CalendarRange, CheckCircle2, CreditCard, LogIn, LogOut, Phone, Search, Users, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CardStep } from "../components/CardWriter";
import { Dialog, useConfirm } from "../components/Dialog";
import { Badge, Button, Card, Checkbox, Empty, Input, PageHeader, Segmented, Spinner } from "../components/ui";
import { useI18n } from "../i18n";
import { api, type Party, type Stay } from "../lib/api";
import { useApp } from "../lib/app";
import { fmtDateTime } from "../lib/format";
import { ExtendDialog, ID_TYPE_KEYS, ReservationDialog, TeamDialog } from "./reception/dialogs";

const STAY_TONE = { reserved: "violet", active: "blue", checked_out: "gray", cancelled: "gray" } as const;

function PartyCard({ party }: { party: Party }) {
  const { encoderId } = useApp();
  const { t, errorText } = useI18n();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [arriving, setArriving] = useState<Party["stays"][number] | null>(null);
  const [cancelPick, setCancelPick] = useState<number[] | null>(null);
  const [extending, setExtending] = useState<Stay | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["parties"] }); qc.invalidateQueries({ queryKey: ["board"] }); };
  const reserved = party.stays.filter((s) => s.status === "reserved");
  const active = party.stays.filter((s) => s.status === "active");

  const cancel = useMutation({
    mutationFn: (ids: number[] | null) => api.post(`/v1/parties/${party.id}/cancel`, { stay_ids: ids }),
    onSuccess: () => { toast.success(t("groups.cancelled")); setCancelPick(null); refresh(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const checkout = useMutation({
    mutationFn: () => api.post(`/v1/parties/${party.id}/checkout`),
    onSuccess: () => { toast.success(t("groups.checkedOut", { name: party.leader_name, count: active.length })); refresh(); },
    onError: (e) => toast.error(errorText(e)),
  });

  const first = party.stays[0];
  const idType = party.leader_id_type ? (ID_TYPE_KEYS[party.leader_id_type] ? t(`idType.${ID_TYPE_KEYS[party.leader_id_type]}`) : party.leader_id_type) : t("guest.id");
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {party.kind === "team" ? <Users className="size-4 text-st-tm" /> : <CalendarRange className="size-4 text-st-ot" />}
            <span className="font-semibold">{party.leader_name}</span>
            <Badge tone={party.kind === "team" ? "violet" : "blue"}>{t(`groups.kind.${party.kind}`)}</Badge>
          </div>
          <div className="mt-1 text-[13px] text-muted flex flex-wrap gap-x-3">
            {first && <span>{fmtDateTime(first.check_in)} – {fmtDateTime(first.check_out)}</span>}
            {party.phone && <span className="flex items-center gap-1"><Phone className="size-3" /><span dir="ltr">{party.phone}</span></span>}
            {party.leader_id_no && <span>{idType} {party.leader_id_no}</span>}
          </div>
          {party.note && <div className="mt-1 text-[13px]">{party.note}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {reserved.length > 0 && (
            <Button size="sm" variant="ghost" icon={<XCircle className="size-4" />}
              onClick={() => setCancelPick(reserved.map((s) => s.id))}>{t("groups.cancel")}</Button>
          )}
          {active.length > 0 && (
            <Button size="sm" icon={<LogOut className="size-4 rtl:-scale-x-100" />} loading={checkout.isPending}
              onClick={async () => {
                if (await confirm({ title: t("groups.confirmCheckout", { name: party.leader_name, count: active.length }),
                  confirmLabel: t("groups.groupCheckout"), message: t("groups.confirmCheckoutText") })) checkout.mutate();
              }}>{t("groups.groupCheckout")}</Button>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {party.stays.map((s) => (
          <div key={s.id} className={clsx("rounded-lg border border-line px-3 py-2", s.status === "cancelled" && "opacity-50")}>
            <div className="flex items-center justify-between">
              <span className="font-semibold tabular-nums">{s.room_no}</span>
              <Badge tone={STAY_TONE[s.status]}>{t(`stayStatus.${s.status}`)}</Badge>
            </div>
            <div className="text-[11px] text-muted">{s.room_type}</div>
            {s.status === "reserved" && new Date(s.check_out) > new Date() && (
              <Button size="sm" variant="primary" className="mt-2 w-full" icon={<LogIn className="size-3.5 rtl:-scale-x-100" />}
                onClick={() => setArriving(s)}>{t("groups.checkIn")}</Button>
            )}
            {s.status === "reserved" && new Date(s.check_out) <= new Date() && (
              // The reservation already ended (late arrival): extend it first, then it can be checked in.
              <Button size="sm" className="mt-2 w-full" icon={<CalendarPlus className="size-3.5" />}
                onClick={async () => setExtending(await api.get<Stay>(`/v1/stays/${s.id}`))}>{t("drawer.extend")}</Button>
            )}
            {s.status === "active" && s.cards_issued === 0 && (
              <Button size="sm" className="mt-2 w-full" icon={<CreditCard className="size-3.5" />} onClick={() => setArriving(s)}>{t("cardStep.writeCard")}</Button>
            )}
            {s.status === "active" && s.cards_issued > 0 && (
              <div className="mt-1 text-[11px] text-muted flex items-center gap-1"><CheckCircle2 className="size-3 text-emerald-500" />{t("board.cardsIssued", { count: s.cards_issued })}</div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={!!arriving} onClose={() => setArriving(null)} title={`${t("drawer.room", { room: arriving?.room_no ?? "" })} · ${party.leader_name}`}
        icon={<LogIn className="size-5 rtl:-scale-x-100" />} footer={<Button onClick={() => setArriving(null)}>{t("common.close")}</Button>}>
        {arriving && (
          <CardStep key={arriving.id} op="issue_guest"
            actionLabel={arriving.status === "reserved" ? t("checkin.submit") : t("cardStep.writeCard")}
            run={() => arriving.status === "reserved"
              ? api.post(`/v1/stays/${arriving.id}/arrive`, { encoder_id: encoderId })
              : api.post(`/v1/stays/${arriving.id}/cards`, { encoder_id: encoderId })}
            onDone={() => { refresh(); setTimeout(() => setArriving(null), 900); }} />
        )}
      </Dialog>

      <ExtendDialog stay={extending} open={!!extending} onClose={() => { setExtending(null); refresh(); }} />

      <Dialog open={!!cancelPick} onClose={() => setCancelPick(null)} title={t("groups.cancelTitle")} size="sm"
        description={t("groups.cancelText")}
        footer={<>
          <Button onClick={() => setCancelPick(null)}>{t("groups.keep")}</Button>
          <Button variant="danger" disabled={!cancelPick?.length} loading={cancel.isPending}
            onClick={() => cancel.mutate(cancelPick)}>{t("groups.cancelRooms", { count: cancelPick?.length ?? 0 })}</Button>
        </>}>
        <div className="flex flex-col gap-2">
          {reserved.map((s) => (
            <Checkbox key={s.id} label={`${t("drawer.room", { room: s.room_no })} · ${s.room_type}`} checked={!!cancelPick?.includes(s.id)}
              onChange={(v) => setCancelPick(v ? [...(cancelPick ?? []), s.id] : (cancelPick ?? []).filter((x) => x !== s.id))} />
          ))}
        </div>
      </Dialog>
    </Card>
  );
}

export default function Groups() {
  const { t } = useI18n();
  const [kind, setKind] = useState<"" | "reservation" | "team">("");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState(false);
  const [dialog, setDialog] = useState<null | "team" | "reserve">(null);
  const parties = useQuery({
    queryKey: ["parties", kind, q, closed],
    queryFn: () => api.get<Party[]>("/v1/parties", { kind: kind || undefined, q: q || undefined, open_only: !closed }),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t("nav.groups")} description={t("groups.intro")}
        actions={<>
          <Button icon={<Users className="size-4" />} onClick={() => setDialog("team")}>{t("team.title")}</Button>
          <Button variant="primary" icon={<CalendarPlus className="size-4" />} onClick={() => setDialog("reserve")}>{t("reservation.title")}</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={kind} onChange={setKind} options={[{ value: "", label: t("common.all") },
          { value: "reservation", label: t("groups.reservations") }, { value: "team", label: t("groups.teams") }]} />
        <div className="relative w-full sm:w-72">
          <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("groups.search")} className="ps-9" />
        </div>
        <Checkbox checked={closed} onChange={setClosed} label={t("groups.includeFinished")} />
      </div>
      {parties.isLoading ? <div className="flex justify-center py-16"><Spinner /></div> :
        !parties.data?.length ? (
          <Card><Empty icon={<CalendarRange className="size-6" />} title={t("groups.empty")}
            description={closed ? t("groups.emptyFiltered") : t("groups.emptyText")} /></Card>
        ) : (
          <div className="space-y-3">{parties.data.map((p) => <PartyCard key={p.id} party={p} />)}</div>
        )}
      <TeamDialog open={dialog === "team"} onClose={() => setDialog(null)} />
      <ReservationDialog open={dialog === "reserve"} onClose={() => setDialog(null)} />
    </div>
  );
}
