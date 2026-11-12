import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRightLeft, CalendarPlus, CheckCircle2, CreditCard, LogOut, Plus, Star, Trash2, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CardStep, STATUS_STYLE } from "../../components/CardWriter";
import { Dialog, useConfirm } from "../../components/Dialog";
import { Badge, Button, Checkbox, Field, Input, Notice, Segmented, Select, Spinner, Textarea } from "../../components/ui";
import { useI18n, useT } from "../../i18n";
import { api, ApiError, type BoardRoom, type CardInspection, type Guest, type Party, type Room, type Stay } from "../../lib/api";
import { useApp } from "../../lib/app";
import { defaultCheckout, fmtDateTime, money, nightsFromToday, toLocalInput } from "../../lib/format";

// ------------------------------------------------------------------------------------- shared bits
export const emptyGuest = (): Guest => ({ name: "", sex: null, id_type: null, id_no: "", phone: "" });

/** ID types are stored in English (canonical) and shown translated. */
export const ID_TYPE_KEYS: Record<string, string> = {
  "ID card": "idCard", "Passport": "passport", "Driving licence": "driving", "Military ID": "military",
  "Phone number": "phone", "Other": "other",
};

function clean(g: Guest): Guest {
  return { name: g.name.trim(), sex: g.sex || null, id_type: g.id_type || null, id_no: g.id_no?.trim() || null, phone: g.phone?.trim() || null };
}

export function GuestFields({ value, onChange, title, compact }: { value: Guest; onChange: (g: Guest) => void; title?: string; compact?: boolean }) {
  const { meta } = useApp();
  const t = useT();
  const set = (patch: Partial<Guest>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3">
      {title && <div className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
        <Field label={t("guest.fullName")} required>
          <Input value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("guest.namePlaceholder")} required />
        </Field>
        <Field label={t("guest.sex")} group>
          <Segmented value={(value.sex ?? "") as "" | "M" | "F"} onChange={(v) => set({ sex: (v || null) as Guest["sex"] })}
            options={[{ value: "", label: "—" }, { value: "M", label: t("guest.male") }, { value: "F", label: t("guest.female") }]} />
        </Field>
      </div>
      {!compact && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label={t("guest.idType")}>
            <Select value={value.id_type ?? ""} onChange={(e) => set({ id_type: e.target.value || null })}>
              <option value="">—</option>
              {meta?.id_types.map((v) => <option key={v} value={v}>{ID_TYPE_KEYS[v] ? t(`idType.${ID_TYPE_KEYS[v]}`) : v}</option>)}
            </Select>
          </Field>
          <Field label={t("guest.idNumber")}><Input value={value.id_no ?? ""} onChange={(e) => set({ id_no: e.target.value })} /></Field>
          <Field label={t("guest.phone")}><Input type="tel" dir="ltr" value={value.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} /></Field>
        </div>
      )}
    </div>
  );
}

function StayDates({ checkOut, setCheckOut, vip, setVip, showVip = true }: {
  checkOut: string; setCheckOut: (v: string) => void; vip?: boolean; setVip?: (v: boolean) => void; showVip?: boolean;
}) {
  const { meta } = useApp();
  const t = useT();
  const time = vip ? meta!.vip_checkout_time : meta!.checkout_time;
  // "Nights" always follows the chosen date, so the two can never disagree.
  const nights = nightsFromToday(checkOut);
  const applyNights = (n: number) => setCheckOut(defaultCheckout(n, time));
  // VIP only moves the check-out *time*; a date picked by hand is kept.
  const toggleVip = (v: boolean) => {
    setVip?.(v);
    const d = new Date(checkOut);
    if (Number.isNaN(d.getTime())) return;
    const [h, m] = (v ? meta!.vip_checkout_time : meta!.checkout_time).split(":").map(Number);
    d.setHours(h, m, 0, 0);
    setCheckOut(toLocalInput(d));
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[110px_1fr] gap-3 items-start">
        <Field label={t("stay.nights")}>
          <Input type="number" min={1} max={365} value={nights} onChange={(e) => applyNights(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={t("stay.checkOut")} hint={t("stay.defaultCheckoutTime", { time })}>
          <Input type="datetime-local" value={checkOut} min={toLocalInput(new Date())} onChange={(e) => setCheckOut(e.target.value)} required />
        </Field>
      </div>
      {showVip && setVip && (
        <Checkbox checked={!!vip} onChange={toggleVip}
          label={<span className="inline-flex items-center gap-1"><Star className="size-3.5 text-amber-500" />{t("stay.vip")}</span>} />
      )}
    </div>
  );
}

export function RoomPicker({ rooms, selected, onToggle, multi, emptyText }: {
  rooms: (Room & { status?: BoardRoom["status"] })[]; selected: number[]; onToggle: (id: number) => void; multi?: boolean; emptyText?: string;
}) {
  const t = useT();
  if (!rooms.length) return <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">{emptyText ?? t("rooms.noFreeRooms")}</div>;
  // Room numbers repeat across buildings (106 in Main and in the Garden wing): then show the building.
  const manyBuildings = new Set(rooms.map((r) => r.building_no)).size > 1;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2 max-h-60 overflow-y-auto pe-1">
      {rooms.map((r) => {
        const on = selected.includes(r.id);
        return (
          <button key={r.id} type="button" onClick={() => onToggle(r.id)} aria-pressed={on}
            aria-label={`${t("drawer.room", { room: r.room_no })} · ${r.building_name} · ${r.room_type}`}
            className={clsx("relative rounded-lg border px-2.5 py-2 text-start transition",
              on ? "border-primary bg-primary-soft ring-1 ring-primary" : "border-line bg-surface hover:bg-surface-2")}>
            <div className="flex items-center gap-1.5">
              {r.status && <span className={clsx("size-1.5 rounded-full", STATUS_STYLE[r.status].dot)} />}
              <span className="font-semibold tabular-nums text-sm">{r.room_no}</span>
              {multi && on && <CheckCircle2 className="ms-auto size-3.5 text-primary" />}
            </div>
            <div className="text-[11px] text-muted truncate">{manyBuildings ? `${r.building_name} · ${r.room_type}` : r.room_type}</div>
          </button>
        );
      })}
    </div>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["board"] });
    qc.invalidateQueries({ queryKey: ["parties"] });
    qc.invalidateQueries({ queryKey: ["stay"] });
    qc.invalidateQueries({ queryKey: ["available"] });
    qc.invalidateQueries({ queryKey: ["report"] });
  };
}

/** Rooms free for the whole period, with their live board status for the coloured dot. */
function useFreeRooms(enabled: boolean, checkIn: string, checkOut: string, board: BoardRoom[] = [], key = "") {
  const q = useQuery({
    queryKey: ["available", key, checkIn, checkOut],
    queryFn: () => api.get<Room[]>("/v1/rooms/available", { check_in: checkIn, check_out: checkOut }),
    enabled: enabled && !!checkIn && !!checkOut && new Date(checkOut) > new Date(checkIn),
  });
  const status = new Map(board.map((r) => [r.id, r.status]));
  return { ...q, rooms: (q.data ?? []).map((r) => ({ ...r, status: status.get(r.id) })) };
}

// ------------------------------------------------------------------------------------- check-in
export function CheckInDialog({ open, onClose, rooms, room: fixedRoom, initialKind = "walkin" }: {
  open: boolean; onClose: () => void; rooms: BoardRoom[]; room?: BoardRoom | null; initialKind?: "walkin" | "hourly";
}) {
  const { meta, encoderId, encoder } = useApp();
  const { t, tr } = useI18n();
  const invalidate = useInvalidate();
  const [roomId, setRoomId] = useState<number | null>(null);
  const [kind, setKind] = useState<"walkin" | "hourly">(initialKind);
  const [checkOut, setCheckOut] = useState("");
  const [vip, setVip] = useState(false);
  const [hours, setHours] = useState(3);
  const [guest, setGuest] = useState<Guest>(emptyGuest());
  const [companions, setCompanions] = useState<Guest[]>([]);
  const [price, setPrice] = useState<string>("");
  const [deposit, setDeposit] = useState("0");
  const [note, setNote] = useState("");
  const [stay, setStay] = useState<Stay | null>(null);
  const [extraCards, setExtraCards] = useState(0);

  useEffect(() => {
    if (!open) return;
    setRoomId(fixedRoom?.id ?? null);
    setKind(initialKind);
    setCheckOut(defaultCheckout(1, meta!.checkout_time));
    setVip(false); setHours(3); setGuest(emptyGuest()); setCompanions([]); setDeposit("0"); setNote("");
    setStay(null); setExtraCards(0); setPrice("");
  }, [open, fixedRoom?.id, initialKind, meta]);

  // Offer only rooms that are free for the whole stay (not just "vacant right now").
  const stayEnd = kind === "hourly" ? toLocalInput(new Date(Date.now() + hours * 3600_000)) : checkOut;
  const startedAt = useMemo(() => toLocalInput(new Date()), [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  const freeQ = useFreeRooms(open && !fixedRoom && !stay, startedAt, stayEnd, rooms, "checkin");
  const free = freeQ.rooms;
  useEffect(() => {
    if (!fixedRoom && roomId && freeQ.data && !freeQ.data.some((r) => r.id === roomId)) setRoomId(null);
  }, [freeQ.data, roomId, fixedRoom]);
  const room = rooms.find((r) => r.id === roomId) ?? fixedRoom ?? null;
  const suggested = room ? (kind === "hourly" ? room.hour_start_price + room.hour_price * hours : room.price) : 0;
  const reserved = room?.status === "OT";
  // A room with a later reservation can only be sold until that reservation starts.
  const resConflict = !!room && !reserved && !!room.reservation && new Date(room.reservation.check_in) < new Date(stayEnd);
  const valid = !!room && guest.name.trim().length > 0 && (kind === "hourly" || new Date(checkOut) > new Date()) && !resConflict;
  const cards = 1 + extraCards;

  const run = () => api.post<Stay>("/v1/reception/check-in", {
    encoder_id: encoderId, room_id: room!.id, kind, guest: clean(guest), companions: companions.filter((c) => c.name.trim()).map(clean),
    check_out: kind === "walkin" ? checkOut : undefined, hours: kind === "hourly" ? hours : undefined, vip,
    price: price === "" ? undefined : Number(price), deposit: Number(deposit) || 0, note: note.trim() || undefined,
    allow_reserved: reserved,
  });

  return (
    <Dialog open={open} onClose={onClose} size="lg" icon={<UserPlus className="size-5" />}
      title={stay ? t("checkin.doneTitle", { room: stay.room.room_no }) : room ? t("checkin.titleRoom", { room: room.room_no }) : t("checkin.title")}
      description={stay ? t("checkin.doneText", { guest: stay.guests[0]?.name ?? "", time: fmtDateTime(stay.check_out) })
        : room ? t("checkin.roomText", { type: room.room_type, building: room.building_name, floor: room.floor_no }) : t("checkin.walkIn")}
      footer={stay ? <Button variant="primary" onClick={onClose}>{t("common.done")}</Button> : <Button onClick={onClose}>{t("common.cancel")}</Button>}>
      {stay ? (
        <div className="space-y-4">
          <Notice tone="green" icon={<CheckCircle2 className="size-4" />}>{t("checkin.cardsWritten", { count: cards })}</Notice>
          {stay.cards_issued + extraCards < stay.room.max_cards && (
            <div>
              <div className="text-sm font-medium mb-2">{t("checkin.anotherCard")}</div>
              <CardStep key={extraCards} op="issue_guest" actionLabel={t("checkin.writeExtra")}
                run={() => api.post<Stay>(`/v1/stays/${stay.id}/cards`, { encoder_id: encoderId })}
                onDone={() => { setExtraCards((n) => n + 1); invalidate(); }} />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {!fixedRoom && (
            <Field label={t("common.room")} required group>
              {freeQ.isLoading ? <Spinner /> : (
                <RoomPicker rooms={free} selected={roomId ? [roomId] : []} onToggle={setRoomId} emptyText={t("rooms.noVacantRooms")} />
              )}
            </Field>
          )}
          {reserved && <Notice tone="amber">{tr("checkin.reservedWarning", { room: room?.room_no, party: <b>{room?.reservation?.party_name}</b>,
            time: fmtDateTime(room?.reservation?.check_in) })}</Notice>}
          {resConflict && <Notice tone="red">{t("checkin.reservationConflict", { room: room!.room_no,
            time: fmtDateTime(room!.reservation!.check_in) })}</Notice>}
          {room?.status === "VD" && <Notice tone="amber">{t("checkin.dirtyWarning", { room: room.room_no })}</Notice>}

          <Segmented value={kind} onChange={setKind} options={[{ value: "walkin", label: t("checkin.overnight") }, { value: "hourly", label: t("checkin.hourly") }]} />
          {kind === "walkin" ? (
            <StayDates checkOut={checkOut} setCheckOut={setCheckOut} vip={vip} setVip={setVip} />
          ) : (
            <Field label={t("checkin.hours")} className="max-w-40">
              <Select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{t("checkin.hoursOption", { count: h })}</option>)}
              </Select>
            </Field>
          )}

          <GuestFields value={guest} onChange={setGuest} title={t("common.guest")} />
          {companions.map((c, i) => (
            <div key={i} className="flex gap-2 items-end">
              <div className="flex-1"><GuestFields compact value={c} onChange={(g) => setCompanions(companions.map((x, j) => (j === i ? g : x)))} /></div>
              <Button variant="ghost" icon={<Trash2 className="size-4" />} aria-label={t("common.remove")} onClick={() => setCompanions(companions.filter((_, j) => j !== i))} />
            </div>
          ))}
          {companions.length < 10 && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setCompanions([...companions, emptyGuest()])}>
              {t("checkin.addCompanion")}
            </Button>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label={meta?.currency ? t("common.priceIn", { currency: meta.currency }) : t("common.price")}
              hint={room ? t("checkin.roomRate", { price: money(suggested) }) : undefined}>
              <Input type="number" min={0} step="0.01" value={price} placeholder={String(suggested)} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label={t("common.deposit")}><Input type="number" min={0} step="0.01" value={deposit} onChange={(e) => setDeposit(e.target.value)} /></Field>
            <Field label={t("common.note")} className="col-span-2 sm:col-span-1"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>

          <CardStep op="issue_guest" actionLabel={t("checkin.submit")} run={run}
            instruction={room ? tr("checkin.placeCardRoom", { encoder: <b>{encoder?.name ?? t("encoder.theEncoder")}</b>, room: <b>{room.room_no}</b> })
              : undefined}
            disabled={!valid} disabledReason={!room ? t("checkin.needRoom") : resConflict
              ? t("checkin.reservationConflict", { room: room.room_no, time: fmtDateTime(room.reservation!.check_in) })
              : !guest.name.trim() ? t("checkin.needName") : t("checkin.needFuture")}
            onDone={(s) => { setStay(s); invalidate(); toast.success(t("checkin.doneTitle", { room: s.room.room_no })); }} />
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- team
export function TeamDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { meta, encoderId } = useApp();
  const { t, tr, errorText } = useI18n();
  const invalidate = useInvalidate();
  const [leader, setLeader] = useState<Guest>(emptyGuest());
  const [checkOut, setCheckOut] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [party, setParty] = useState<Party | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    setLeader(emptyGuest()); setCheckOut(defaultCheckout(1, meta!.checkout_time)); setSelected([]); setPrice(""); setNote("");
    setParty(null); setSkipped([]); create.reset();
  }, [open, meta]);

  const avail = useQuery({
    queryKey: ["available", "team", checkOut],
    queryFn: () => api.get<Room[]>("/v1/rooms/available", { check_in: toLocalInput(new Date()), check_out: checkOut }),
    enabled: open && !party && !!checkOut && new Date(checkOut) > new Date(),
  });
  useEffect(() => {
    if (avail.data) setSelected((sel) => sel.filter((id) => avail.data.some((r) => r.id === id)));
  }, [avail.data]);
  const create = useMutation({
    mutationFn: () => api.post<Party>("/v1/reception/team", { leader: clean(leader), room_ids: selected, check_out: checkOut,
      price: price === "" ? undefined : Number(price), note: note.trim() || undefined }),
    onSuccess: (p) => { setParty(p); invalidate(); },
  });
  const refresh = async () => setParty(await api.get<Party>(`/v1/parties/${party!.id}`));

  const pending = party?.stays.filter((s) => s.status === "active" && s.cards_issued === 0 && !skipped.includes(s.id)) ?? [];
  const current = pending[0];

  return (
    <Dialog open={open} onClose={onClose} size="lg" icon={<Users className="size-5" />}
      title={party ? t("team.titleParty", { name: party.leader_name }) : t("team.title")}
      description={party ? t("team.partyText", { count: party.stays.length, time: fmtDateTime(party.stays[0]?.check_out) }) : t("team.intro")}
      footer={party ? <Button variant="primary" onClick={onClose}>{pending.length ? t("team.finishLater") : t("common.done")}</Button> : <>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={create.isPending} disabled={!leader.name.trim() || !selected.length}
          onClick={() => create.mutate()}>{t("team.register", { count: selected.length })}</Button>
      </>}>
      {!party ? (
        <div className="space-y-5">
          <GuestFields value={leader} onChange={setLeader} title={t("team.leader")} />
          <StayDates checkOut={checkOut} setCheckOut={setCheckOut} showVip={false} />
          <Field label={t("team.roomsSelected", { count: selected.length })} required group>
            {avail.isLoading ? <Spinner /> : (
              <RoomPicker multi rooms={avail.data ?? []} selected={selected}
                onToggle={(id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])} />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("team.pricePerRoom")} hint={t("team.pricePerRoomHint")}><Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
            <Field label={t("common.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          {create.isError && <Notice tone="red">{errorText(create.error)}</Notice>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {party.stays.map((s) => (
              <Badge key={s.id} tone={s.cards_issued ? "green" : s.id === current?.id ? "blue" : skipped.includes(s.id) ? "amber" : "gray"}>
                {s.cards_issued ? <CheckCircle2 className="size-3" /> : <CreditCard className="size-3" />} {s.room_no}
              </Badge>
            ))}
          </div>
          {current ? (
            <>
              <CardStep key={current.id} op="issue_guest" actionLabel={t("team.writeFor", { room: current.room_no })}
                instruction={tr("team.placeFor", { room: <b>{current.room_no}</b>, n: party.stays.length - pending.length + 1, total: party.stays.length })}
                run={() => api.post(`/v1/stays/${current.id}/cards`, { encoder_id: encoderId })}
                onDone={() => { refresh(); invalidate(); }} />
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setSkipped([...skipped, current.id])}>{t("team.skip", { room: current.room_no })}</Button>
              </div>
            </>
          ) : (
            <Notice tone={skipped.length ? "amber" : "green"} icon={<CheckCircle2 className="size-4" />}>
              {skipped.length ? t("team.doneSkipped", { count: skipped.length }) : t("team.allDone")}
            </Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- reservation
export function ReservationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { meta } = useApp();
  const { t, errorText } = useI18n();
  const invalidate = useInvalidate();
  const [leader, setLeader] = useState<Guest>(emptyGuest());
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    const ci = new Date();
    ci.setDate(ci.getDate() + 1);
    ci.setHours(14, 0, 0, 0);
    setLeader(emptyGuest()); setCheckIn(toLocalInput(ci)); setCheckOut(defaultCheckout(2, meta!.checkout_time)); setSelected([]); setNote("");
    create.reset();
  }, [open, meta]);

  const validDates = !!checkIn && !!checkOut && new Date(checkOut) > new Date(checkIn);
  const avail = useQuery({
    queryKey: ["available", checkIn, checkOut],
    queryFn: () => api.get<Room[]>("/v1/rooms/available", { check_in: checkIn, check_out: checkOut }),
    enabled: open && validDates,
  });
  useEffect(() => {
    if (avail.data) setSelected((s) => s.filter((id) => avail.data.some((r) => r.id === id)));
  }, [avail.data]);

  const create = useMutation({
    mutationFn: () => api.post<Party>("/v1/reservations", { leader: clean(leader), room_ids: selected, check_in: checkIn,
      check_out: checkOut, note: note.trim() || undefined }),
    onSuccess: (p) => { toast.success(t("reservation.done", { count: p.stays.length, name: p.leader_name })); invalidate(); onClose(); },
  });

  return (
    <Dialog open={open} onClose={onClose} size="lg" icon={<CalendarPlus className="size-5" />} title={t("reservation.title")}
      description={t("reservation.intro")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={create.isPending} disabled={!leader.name.trim() || !selected.length || !validDates}
          onClick={() => create.mutate()}>{t("reservation.submit", { count: selected.length })}</Button>
      </>}>
      <div className="space-y-5">
        <GuestFields value={leader} onChange={setLeader} title={t("reservation.leader")} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={t("reservation.arrival")} required><Input type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></Field>
          <Field label={t("reservation.departure")} required error={checkIn && checkOut && !validDates ? t("reservation.departureAfter") : undefined}>
            <Input type="datetime-local" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </Field>
        </div>
        <Field label={t("reservation.freeRooms", { count: selected.length })} required group>
          {avail.isLoading ? <Spinner /> : (
            <RoomPicker multi rooms={avail.data ?? []} selected={selected} emptyText={t("reservation.noFree")}
              onToggle={(id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])} />
          )}
        </Field>
        <Field label={t("common.note")}><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {create.isError && <Notice tone="red">{errorText(create.error)}</Notice>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- extend
export function ExtendDialog({ stay, open, onClose }: { stay: Stay | null; open: boolean; onClose: () => void }) {
  const { meta, encoderId } = useApp();
  const { t, errorText } = useI18n();
  const invalidate = useInvalidate();
  const [checkOut, setCheckOut] = useState("");
  const [rewrite, setRewrite] = useState(true);

  useEffect(() => {
    if (!open || !stay) return;
    const d = new Date(stay.check_out);
    const base = d > new Date() ? d : new Date();
    const [h, m] = (stay.vip ? meta!.vip_checkout_time : meta!.checkout_time).split(":").map(Number);
    base.setDate(base.getDate() + 1);
    base.setHours(h, m, 0, 0);
    setCheckOut(toLocalInput(base));
    setRewrite(stay.status === "active");
    save.reset();
  }, [open, stay, meta]);

  const bump = (days: number) => {
    const d = new Date(checkOut);
    d.setDate(d.getDate() + days);
    setCheckOut(toLocalInput(d));
  };
  const save = useMutation({
    mutationFn: () => api.post<Stay>(`/v1/stays/${stay!.id}/extend`, { check_out: checkOut }),
    onSuccess: () => { toast.success(t("extend.done")); invalidate(); onClose(); },
  });
  if (!stay) return null;
  const valid = new Date(checkOut) > new Date();

  return (
    <Dialog open={open} onClose={onClose} title={t("extend.title", { room: stay.room.room_no })} icon={<CalendarPlus className="size-5" />}
      description={t("extend.current", { time: fmtDateTime(stay.check_out) })}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      <div className="space-y-4">
        <Field label={t("extend.newCheckout")}>
          <Input type="datetime-local" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          {[1, 2, 7].map((n) => <Button key={n} size="sm" onClick={() => bump(n)}>{t("extend.plusNights", { count: n })}</Button>)}
        </div>
        {stay.status === "active" && <Checkbox checked={rewrite} onChange={setRewrite} label={t("extend.rewrite")} />}
        {rewrite ? (
          <CardStep op="issue_guest" actionLabel={t("extend.submitCard")} disabled={!valid} disabledReason={t("extend.pickFuture")}
            instruction={t("extend.placeCard")}
            run={() => api.post<Stay>(`/v1/stays/${stay.id}/extend`, { check_out: checkOut, encoder_id: encoderId })}
            onDone={() => { toast.success(t("extend.doneCard")); invalidate(); onClose(); }} />
        ) : (
          <>
            <Notice tone="amber">{t("extend.noRewriteWarning", { time: fmtDateTime(stay.check_out) })}</Notice>
            {save.isError && <Notice tone="red">{errorText(save.error)}</Notice>}
            <div className="flex justify-end"><Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>{t("extend.saveDate")}</Button></div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- change room
export function MoveDialog({ stay, rooms, open, onClose }: { stay: Stay | null; rooms: BoardRoom[]; open: boolean; onClose: () => void }) {
  const { encoderId } = useApp();
  const { t, tr } = useI18n();
  const invalidate = useInvalidate();
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => { if (open) setTarget(null); }, [open]);
  // Only rooms free for the rest of this guest's stay (a room reserved tomorrow is not "free").
  const startedAt = useMemo(() => toLocalInput(new Date()), [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  const until = stay && new Date(stay.check_out) > new Date() ? stay.check_out : toLocalInput(new Date(Date.now() + 60_000));
  const freeQ = useFreeRooms(open && !!stay, startedAt, until, rooms, "move");
  if (!stay) return null;
  const free = freeQ.rooms.filter((r) => r.id !== stay.room_id);
  const to = rooms.find((r) => r.id === target);

  return (
    <Dialog open={open} onClose={onClose} title={t("move.title", { room: stay.room.room_no })} icon={<ArrowRightLeft className="size-5" />}
      description={stay.guests[0]?.name} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      <div className="space-y-4">
        <Field label={t("move.to")} group>
          {freeQ.isLoading ? <Spinner /> : <RoomPicker rooms={free} selected={target ? [target] : []} onToggle={setTarget} />}
        </Field>
        {to && to.price !== stay.room.price && (
          <Notice tone="blue">{t("move.rateDiff", { room: to.room_no, price: money(to.price), current: money(stay.room.price) })}</Notice>
        )}
        <CardStep op="issue_guest" actionLabel={to ? t("move.submitTo", { room: to.room_no }) : t("move.submit")}
          disabled={!to} disabledReason={t("move.chooseRoom")}
          instruction={tr("move.placeCard", { room: <b>{to?.room_no ?? "…"}</b> })}
          run={() => api.post<Stay>(`/v1/stays/${stay.id}/move`, { encoder_id: encoderId, room_id: target })}
          onDone={(s) => { toast.success(t("move.done", { room: s.room.room_no, old: stay.room.room_no })); invalidate(); onClose(); }} />
        <p className="text-xs text-muted">{t("move.collectOld")}</p>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- check-out
export function CheckoutDialog({ stay, open, onClose }: { stay: Stay | null; open: boolean; onClose: () => void }) {
  const { encoderId, meta } = useApp();
  const { t, tr, errorText } = useI18n();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const noCard = useMutation({
    mutationFn: () => api.post<Stay>(`/v1/stays/${stay!.id}/checkout`),
    onSuccess: () => { toast.success(t("checkout.done", { room: stay!.room.room_no })); invalidate(); onClose(); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!stay) return null;

  const withCard = async () => {
    const info = await api.post<CardInspection>("/v1/cards/inspect", { encoder_id: encoderId });
    if (info.stay?.id !== stay.id) {
      throw new ApiError(409, { error: "wrong_card", message: info.blank ? t("checkout.blankCard")
        : info.stay ? t("checkout.otherRoom", { room: info.stay.room.room_no, expected: stay.room.room_no }) : t("checkout.notThisRoom") });
    }
    return api.post<Stay>("/v1/cards/checkout", { encoder_id: encoderId, erase: true });
  };
  const deposit = stay.deposit ? t("checkout.deposit", { amount: money(stay.deposit, meta?.currency) }) : null;

  return (
    <Dialog open={open} onClose={onClose} title={t("checkout.title", { room: stay.room.room_no })} icon={<LogOut className="size-5 rtl:-scale-x-100" />}
      description={`${stay.guests[0]?.name ?? ""}${deposit ? " · " + deposit : ""}`} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      <div className="space-y-4">
        <div className="text-sm font-medium">{t("checkout.withCard")}</div>
        <CardStep op="erase_card" actionLabel={t("checkout.submitCard")} doneLabel={t("checkout.doneCard")}
          instruction={tr("checkout.placeGuestCard", { room: <b>{stay.room.room_no}</b> })}
          run={withCard} onDone={() => { toast.success(t("checkout.done", { room: stay.room.room_no })); invalidate(); onClose(); }} />
        <div className="relative py-1 text-center text-xs text-muted">
          <span className="relative z-10 bg-surface px-2">{t("common.or")}</span>
          <span className="absolute inset-x-0 top-1/2 border-t border-line" />
        </div>
        <div className="rounded-xl border border-line p-4">
          <div className="text-sm font-medium">{t("checkout.noCardTitle")}</div>
          <p className="text-xs text-muted mt-1">{t("checkout.noCardText", { time: fmtDateTime(stay.check_out) })}</p>
          <div className="flex justify-end mt-3">
            <Button variant="danger" loading={noCard.isPending} onClick={async () => {
              if (await confirm({ title: t("checkout.confirmNoCard", { room: stay.room.room_no }), danger: true, confirmLabel: t("checkout.checkOut") })) noCard.mutate();
            }}>{t("checkout.submitNoCard")}</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
