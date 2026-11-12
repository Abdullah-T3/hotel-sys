import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRightLeft, CalendarPlus, Clock, CreditCard, DoorOpen, LogIn, LogOut, Phone, Sparkles, Star,
  Users, Wrench, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CardStep, StatusBadge } from "../../components/CardWriter";
import { Drawer, useConfirm } from "../../components/Dialog";
import { Badge, Button, Input, Kv, Notice, Segmented, Spinner } from "../../components/ui";
import { useI18n, useT } from "../../i18n";
import { api, type BoardRoom, type Party, type Room, type Stay } from "../../lib/api";
import { useApp } from "../../lib/app";
import { actorName, cardShort, fmtDateTime, money, nights } from "../../lib/format";
import { CheckInDialog, CheckoutDialog, ExtendDialog, ID_TYPE_KEYS, MoveDialog, ReservationDialog } from "./dialogs";

function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-line">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Housekeeping({ room }: { room: BoardRoom }) {
  const { can } = useApp();
  const { t, errorText } = useI18n();
  const qc = useQueryClient();
  const [note, setNote] = useState(room.maintenance_note ?? "");
  const set = useMutation({
    mutationFn: (v: Room["housekeeping"]) => api.put(`/v1/rooms/${room.id}/housekeeping`, { housekeeping: v, note: v === "maintenance" ? note || null : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }),
    onError: (e) => toast.error(errorText(e)),
  });
  if (!can("room_status")) return null;
  const occupied = !!room.stay;
  return (
    <Section title={t("drawer.housekeeping")}>
      <Segmented value={room.housekeeping} onChange={(v) => set.mutate(v)}
        options={[
          { value: "clean", label: <span className="flex items-center gap-1.5"><Sparkles className="size-3.5" />{t("drawer.clean")}</span> },
          { value: "dirty", label: t("drawer.dirty") },
          ...(occupied && room.housekeeping !== "maintenance" ? [] : [{ value: "maintenance" as const, label: <span className="flex items-center gap-1.5"><Wrench className="size-3.5" />{t("status.OO")}</span> }]),
        ]} />
      {room.housekeeping === "maintenance" && (
        <div className="mt-2 flex gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("drawer.oooReason")} />
          <Button size="sm" onClick={() => set.mutate("maintenance")} loading={set.isPending}>{t("common.save")}</Button>
        </div>
      )}
    </Section>
  );
}

function StayPanel({ stayId, room, rooms }: { stayId: number; room: BoardRoom; rooms: BoardRoom[] }) {
  const { meta, encoderId } = useApp();
  const { t, intl } = useI18n();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | "extend" | "move" | "checkout">(null);
  const [extraKey, setExtraKey] = useState(0);
  const [showExtra, setShowExtra] = useState(false);
  const q = useQuery({ queryKey: ["stay", stayId], queryFn: () => api.get<Stay>(`/v1/stays/${stayId}`) });
  if (q.isLoading || !q.data) return <div className="p-6 flex justify-center"><Spinner /></div>;
  const s = q.data;
  const primary = s.guests[0];
  const refresh = () => ["stay", "board", "parties", "available", "report"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const noCard = s.cards_issued === 0;
  const atMax = s.cards_issued >= s.room.max_cards;
  const idType = primary?.id_type ? (ID_TYPE_KEYS[primary.id_type] ? t(`idType.${ID_TYPE_KEYS[primary.id_type]}`) : primary.id_type) : t("guest.id");

  return (
    <>
      <Section title={t(`stayKind.${s.kind}`)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-lg font-semibold">
              {s.vip && <Star className="size-4 fill-amber-400 text-amber-400" />}
              <span className="truncate">{primary?.name}</span>
            </div>
            <div className="text-[13px] text-muted flex flex-wrap gap-x-3">
              {primary?.phone && <span className="flex items-center gap-1"><Phone className="size-3" /><span dir="ltr">{primary.phone}</span></span>}
              {primary?.id_no && <span>{idType} {primary.id_no}</span>}
            </div>
          </div>
          {s.party && <Badge tone="violet"><Users className="size-3" />{s.party.leader_name}</Badge>}
        </div>
        {s.guests.length > 1 && (
          <div className="mt-2 text-[13px] text-muted">{t("drawer.with", { names: new Intl.ListFormat(intl, { type: "conjunction" }).format(s.guests.slice(1).map((g) => g.name)) })}</div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-surface-2 p-3">
            <div className="text-[11px] text-muted flex items-center gap-1"><LogIn className="size-3 rtl:-scale-x-100" />{t("drawer.checkIn")}</div>
            <div className="text-sm font-medium">{fmtDateTime(s.check_in)}</div>
          </div>
          <div className={clsx("rounded-lg p-3", s.overdue ? "bg-red-500/10" : "bg-surface-2")}>
            <div className={clsx("text-[11px] flex items-center gap-1", s.overdue ? "text-red-600" : "text-muted")}>
              <LogOut className="size-3 rtl:-scale-x-100" />{s.overdue ? t("drawer.overdueSince") : t("stay.checkOut")}</div>
            <div className="text-sm font-medium">{fmtDateTime(s.check_out)}</div>
          </div>
        </div>
        <div className="mt-2 divide-y divide-line">
          <Kv label={t("drawer.length")}>{s.kind === "hourly" ? t("stayKind.hourlyShort") : t("drawer.nights", { count: nights(s.check_in, s.check_out) })}</Kv>
          <Kv label={t("common.price")}>{money(s.price, meta?.currency)}</Kv>
          {s.deposit > 0 && <Kv label={t("common.deposit")}>{money(s.deposit, meta?.currency)}</Kv>}
          {s.note && <Kv label={t("common.note")}>{s.note}</Kv>}
          <Kv label={t("drawer.checkedInBy")}>{actorName(s.created_by)}</Kv>
        </div>
      </Section>

      <Section title={t("drawer.actions")}>
        {noCard && (
          <div className="space-y-2 mb-3">
            <Notice tone="amber" icon={<CreditCard className="size-4" />}>{t("drawer.noCardYet")}</Notice>
            {!s.overdue && (
              <CardStep op="issue_guest" actionLabel={t("drawer.writeRoomCard")} run={() => api.post(`/v1/stays/${s.id}/cards`, { encoder_id: encoderId })}
                onDone={() => { toast.success(t("cardStep.written")); refresh(); }} />
            )}
          </div>
        )}
        {/* The actions are always available - also for a team room that has no card yet. */}
        <div className="grid grid-cols-2 gap-2">
          {!noCard && (
            <Button icon={<CreditCard className="size-4" />} disabled={atMax || s.overdue}
              title={atMax ? t("drawer.maxCards", { count: s.room.max_cards }) : s.overdue ? t("drawer.extendFirst") : undefined}
              onClick={() => { setShowExtra(!showExtra); setExtraKey((k) => k + 1); }}>{t("drawer.anotherCard")}</Button>
          )}
          <Button icon={<CalendarPlus className="size-4" />} onClick={() => setDialog("extend")}>{t("drawer.extend")}</Button>
          <Button icon={<ArrowRightLeft className="size-4" />} onClick={() => setDialog("move")}>{t("drawer.changeRoom")}</Button>
          <Button variant="primary" icon={<LogOut className="size-4 rtl:-scale-x-100" />} onClick={() => setDialog("checkout")}>{t("checkout.checkOut")}</Button>
        </div>
        {showExtra && !noCard && (
          <div className="mt-3">
            <CardStep key={extraKey} op="issue_guest" actionLabel={t("checkin.writeExtra")} doneLabel={t("drawer.extraWritten")}
              run={() => api.post(`/v1/stays/${s.id}/cards`, { encoder_id: encoderId })}
              onDone={() => { refresh(); setTimeout(() => setShowExtra(false), 1200); }} />
          </div>
        )}
      </Section>

      <Section title={t("drawer.cards", { count: s.cards.length })}>
        {s.cards.length === 0 ? <div className="text-sm text-muted">{t("drawer.noneYet")}</div> : (
          <ul className="space-y-1.5">
            {s.cards.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-[13px]">
                <CreditCard className="size-3.5 text-muted shrink-0" />
                <code dir="ltr" className="text-xs text-muted" title={c.card_data ?? ""}>{cardShort(c.card_data)}</code>
                <span className="text-muted truncate">{fmtDateTime(c.issued_at)}{c.note ? ` · ${c.note}` : ""}</span>
                <Badge className="ms-auto" tone={c.status === "active" ? "green" : c.status === "expired" ? "amber" : "gray"}>{t(`cardStatus.${c.status}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ExtendDialog stay={s} open={dialog === "extend"} onClose={() => { setDialog(null); refresh(); }} />
      <MoveDialog stay={s} rooms={rooms} open={dialog === "move"} onClose={() => { setDialog(null); refresh(); }} />
      <CheckoutDialog stay={s} open={dialog === "checkout"} onClose={() => { setDialog(null); refresh(); }} />
      {room.reservation && (
        <div className="px-5 py-3 text-[13px] text-muted flex items-center gap-1.5">
          <Clock className="size-3.5" />{t("drawer.nextReservation", { name: room.reservation.party_name, time: fmtDateTime(room.reservation.check_in) })}
        </div>
      )}
    </>
  );
}

function ReservationPanel({ room }: { room: BoardRoom }) {
  const { encoderId } = useApp();
  const { t, errorText } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const r = room.reservation!;
  const cancel = useMutation({
    mutationFn: () => api.post<Party>(`/v1/parties/${r.party_id}/cancel`, { stay_ids: [r.stay_id] }),
    onSuccess: () => { toast.success(t("drawer.reservationCancelled")); qc.invalidateQueries({ queryKey: ["board"] }); qc.invalidateQueries({ queryKey: ["parties"] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  const early = new Date(r.check_in) > new Date();
  return (
    <Section title={t("drawer.reservation")}>
      <div className="font-semibold">{r.party_name}</div>
      <div className="text-[13px] text-muted">{fmtDateTime(r.check_in)} – {fmtDateTime(r.check_out)}</div>
      {!room.stay && (
        <div className="mt-3 space-y-2">
          {early && <Notice tone="blue">{t("drawer.earlyArrival")}</Notice>}
          <CardStep op="issue_guest" actionLabel={t("checkin.submit")}
            run={() => api.post<Stay>(`/v1/stays/${r.stay_id}/arrive`, { encoder_id: encoderId })}
            onDone={() => { toast.success(t("drawer.arrived", { name: r.party_name, room: room.room_no })); qc.invalidateQueries({ queryKey: ["board"] }); qc.invalidateQueries({ queryKey: ["parties"] }); }} />
        </div>
      )}
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" icon={<XCircle className="size-4" />} loading={cancel.isPending}
          onClick={async () => { if (await confirm({ title: t("drawer.confirmCancel", { room: room.room_no }), danger: true, confirmLabel: t("drawer.cancelReservation") })) cancel.mutate(); }}>
          {t("drawer.cancelReservation")}
        </Button>
      </div>
    </Section>
  );
}

export function RoomDrawer({ room, rooms, onClose }: { room: BoardRoom | null; rooms: BoardRoom[]; onClose: () => void }) {
  const { meta } = useApp();
  const t = useT();
  const [dialog, setDialog] = useState<null | "walkin" | "hourly" | "reserve">(null);
  if (!room) return null;
  const vacant = !room.stay && room.status !== "OO";

  return (
    <>
      <Drawer open onClose={onClose} title={
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-surface-2 p-2.5"><DoorOpen className="size-5" /></div>
          <div>
            <div className="text-lg font-semibold leading-tight">{t("drawer.room", { room: room.room_no })}</div>
            <div className="text-[13px] text-muted">{t("checkin.roomText", { type: room.room_type, building: room.building_name, floor: room.floor_no })}</div>
          </div>
        </div>} subtitle={<div className="flex items-center gap-2 pt-1"><StatusBadge status={room.status} />
          <span>{t("drawer.perNight", { price: money(room.price, meta?.currency) })}</span></div>}>
        {room.stay && <StayPanel key={room.stay.id} stayId={room.stay.id} room={room} rooms={rooms} />}
        {room.reservation && !room.stay && <ReservationPanel room={room} />}
        {vacant && (
          <Section title={t("drawer.vacant")}>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="primary" className="col-span-2" icon={<LogIn className="size-4 rtl:-scale-x-100" />} onClick={() => setDialog("walkin")}>{t("drawer.checkInGuest")}</Button>
              <Button icon={<Clock className="size-4" />} onClick={() => setDialog("hourly")}>{t("drawer.hourlyRoom")}</Button>
              <Button icon={<CalendarPlus className="size-4" />} onClick={() => setDialog("reserve")}>{t("drawer.reserve")}</Button>
            </div>
          </Section>
        )}
        {room.status === "OO" && (
          <Section title={t("status.OO")}>
            <Notice tone="gray" icon={<Wrench className="size-4" />}>{room.maintenance_note || t("drawer.blocked")}</Notice>
          </Section>
        )}
        <Housekeeping key={room.id + room.housekeeping} room={room} />
        <Section title={t("drawer.lock")}>
          <div className="divide-y divide-line">
            <Kv label={t("drawer.lockNumber")}><span dir="ltr">{room.building_no}-{room.floor_no}-{room.lock_room}</span></Kv>
            <Kv label={t("rooms.maxCards")}>{room.max_cards}</Kv>
            {room.public_door && <Kv label={t("drawer.publicDoor")}>{t("common.yes")}</Kv>}
          </div>
        </Section>
      </Drawer>
      <CheckInDialog open={dialog === "walkin" || dialog === "hourly"} onClose={() => setDialog(null)} rooms={rooms} room={room}
        initialKind={dialog === "hourly" ? "hourly" : "walkin"} />
      <ReservationDialog open={dialog === "reserve"} onClose={() => setDialog(null)} />
    </>
  );
}
