import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Building2, Layers, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Dialog, useConfirm } from "../components/Dialog";
import { Badge, Button, Card, Checkbox, Empty, Field, IconButton, Input, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n, useT } from "../i18n";
import { api, type Building, type Room } from "../lib/api";
import { useApp } from "../lib/app";
import { money } from "../lib/format";

interface RoomForm {
  room_no: string; floor_no: string; lock_room: string; room_type: string; price: string; hour_start_price: string;
  hour_price: string; max_cards: string; public_door: boolean; note: string;
}
const blankForm = (): RoomForm => ({ room_no: "", floor_no: "1", lock_room: "1", room_type: "Standard", price: "0",
  hour_start_price: "0", hour_price: "0", max_cards: "5", public_door: false, note: "" });

function useInvalidateRooms() {
  const qc = useQueryClient();
  return () => ["rooms", "buildings", "board"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

function RoomFields({ form, set, withLock = true }: { form: RoomForm; set: (p: Partial<RoomForm>) => void; withLock?: boolean }) {
  const { meta } = useApp();
  const t = useT();
  const withCur = (label: string) => (meta?.currency ? `${label} (${meta.currency})` : label);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {withLock && <>
        <Field label={t("rooms.roomNumber")} required><Input value={form.room_no} onChange={(e) => set({ room_no: e.target.value })} /></Field>
        <Field label={t("rooms.floor")} hint="0–98"><Input type="number" min={0} max={98} value={form.floor_no} onChange={(e) => set({ floor_no: e.target.value })} /></Field>
        <Field label={t("rooms.lockRoom")} hint={t("rooms.lockRoomHint")}><Input type="number" min={0} max={98} value={form.lock_room} onChange={(e) => set({ lock_room: e.target.value })} /></Field>
      </>}
      <Field label={t("rooms.type")}><Input value={form.room_type} onChange={(e) => set({ room_type: e.target.value })} list="room-types" /></Field>
      <Field label={withCur(t("rooms.pricePerNight"))}><Input type="number" min={0} step="0.01" value={form.price} onChange={(e) => set({ price: e.target.value })} /></Field>
      <Field label={t("rooms.maxCards")} hint="1–255"><Input type="number" min={1} max={255} value={form.max_cards} onChange={(e) => set({ max_cards: e.target.value })} /></Field>
      <Field label={withCur(t("rooms.hourStart"))}><Input type="number" min={0} step="0.01" value={form.hour_start_price} onChange={(e) => set({ hour_start_price: e.target.value })} /></Field>
      <Field label={withCur(t("rooms.hourExtra"))}><Input type="number" min={0} step="0.01" value={form.hour_price} onChange={(e) => set({ hour_price: e.target.value })} /></Field>
      <Field label={t("common.note")}><Input value={form.note} onChange={(e) => set({ note: e.target.value })} /></Field>
      <Checkbox className="col-span-2 sm:col-span-3" checked={form.public_door} onChange={(v) => set({ public_door: v })} label={t("rooms.publicDoor")} />
      <datalist id="room-types">{["Standard", "Single", "Double", "Twin", "Suite", "Family", "Deluxe"].map((x) => <option key={x} value={x} />)}</datalist>
    </div>
  );
}

function payload(f: RoomForm) {
  return { room_type: f.room_type.trim() || "Standard", price: Number(f.price) || 0, hour_start_price: Number(f.hour_start_price) || 0,
    hour_price: Number(f.hour_price) || 0, max_cards: Number(f.max_cards) || 1, public_door: f.public_door, note: f.note.trim() || null };
}

function RoomDialog({ open, onClose, building, room }: { open: boolean; onClose: () => void; building: number; room: Room | null }) {
  const { t, errorText } = useI18n();
  const invalidate = useInvalidateRooms();
  const [form, setForm] = useState<RoomForm>(blankForm());
  useEffect(() => {
    if (!open) return;
    setForm(room ? { room_no: room.room_no, floor_no: String(room.floor_no), lock_room: String(room.lock_room), room_type: room.room_type,
      price: String(room.price), hour_start_price: String(room.hour_start_price), hour_price: String(room.hour_price),
      max_cards: String(room.max_cards), public_door: room.public_door, note: room.note ?? "" } : blankForm());
  }, [open, room]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...payload(form), room_no: form.room_no.trim(), floor_no: Number(form.floor_no), lock_room: Number(form.lock_room) };
      return room ? api.patch(`/v1/rooms/${room.id}`, body) : api.post("/v1/rooms", { ...body, building_no: building });
    },
    onSuccess: () => { toast.success(room ? t("rooms.saved") : t("rooms.added")); invalidate(); onClose(); },
  });
  return (
    <Dialog open={open} onClose={onClose} title={room ? t("rooms.editTitle", { room: room.room_no }) : t("rooms.addRoom")} size="lg"
      footer={<><Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!form.room_no.trim()} onClick={() => save.mutate()}>{t("common.save")}</Button></>}>
      <RoomFields form={form} set={(p) => setForm({ ...form, ...p })} />
      {save.isError && <Notice tone="red" className="mt-3">{errorText(save.error)}</Notice>}
    </Dialog>
  );
}

function expand(floors: string, rooms: string) {
  const rng = (s: string) => {
    const m = s.trim().match(/^(\d{1,4})\s*(?:-\s*(\d{1,4}))?$/);
    return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
  };
  const f = rng(floors), r = rng(rooms);
  if (!f || !r || f[1] < f[0] || r[1] < r[0]) return null;
  const first = r[0] % 100, last = r[1] % 100;
  if (first > last || last > 98 || f[1] > 98) return null;
  const out: string[] = [];
  for (let fl = f[0]; fl <= f[1]; fl++) for (let i = first; i <= last; i++) out.push(`${fl}${String(i).padStart(2, "0")}`);
  return out;
}

function BatchDialog({ open, onClose, building }: { open: boolean; onClose: () => void; building: number }) {
  const { t, tr, errorText } = useI18n();
  const invalidate = useInvalidateRooms();
  const [floors, setFloors] = useState("1-5");
  const [rooms, setRooms] = useState("101-518");
  const [form, setForm] = useState<RoomForm>(blankForm());
  useEffect(() => { if (open) { setFloors("1-5"); setRooms("101-518"); setForm(blankForm()); } }, [open]);
  const preview = useMemo(() => expand(floors, rooms), [floors, rooms]);
  const save = useMutation({
    mutationFn: () => api.post<{ created: string[]; skipped: string[] }>("/v1/rooms/batch", { building_no: building, floors, rooms, ...payload(form) }),
    onSuccess: (r) => {
      toast.success(r.skipped.length ? t("rooms.batchDoneSkipped", { count: r.created.length, skipped: r.skipped.length })
        : t("rooms.batchDone", { count: r.created.length }));
      invalidate(); onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("rooms.batchTitle")} size="lg" icon={<Layers className="size-5" />}
      description={t("rooms.batchIntro")}
      footer={<><Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!preview?.length} onClick={() => save.mutate()}>
          {t("rooms.batchSubmit", { count: preview?.length ?? 0 })}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("rooms.floors")} hint={t("rooms.floorsHint")}><Input dir="ltr" value={floors} onChange={(e) => setFloors(e.target.value)} /></Field>
          <Field label={t("rooms.rooms")} hint={t("rooms.roomsHint")}><Input dir="ltr" value={rooms} onChange={(e) => setRooms(e.target.value)} /></Field>
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-[13px]">
          {preview ? (
            <>{tr("rooms.batchPreview", { count: <b>{preview.length}</b> })}{" "}
              <span dir="ltr">{preview.slice(0, 12).join(", ")}{preview.length > 12 && ` … ${preview.slice(-3).join(", ")}`}</span></>
          ) : <span className="text-red-600">{t("rooms.batchInvalid")}</span>}
        </div>
        <RoomFields form={form} set={(p) => setForm({ ...form, ...p })} withLock={false} />
        <p className="text-xs text-muted">{t("rooms.batchNote")}</p>
        {save.isError && <Notice tone="red">{errorText(save.error)}</Notice>}
      </div>
    </Dialog>
  );
}

function BuildingDialog({ open, onClose, building, used }: { open: boolean; onClose: () => void; building: Building | null; used: number[] }) {
  const { t, errorText } = useI18n();
  const invalidate = useInvalidateRooms();
  const [no, setNo] = useState("1");
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    setNo(String(building?.no ?? Array.from({ length: 16 }, (_, i) => i).find((i) => !used.includes(i) && i > 0) ?? 0));
    setName(building?.name ?? "");
  }, [open, building, used]);
  const save = useMutation({
    mutationFn: () => building ? api.patch(`/v1/buildings/${building.no}`, { name }) : api.post("/v1/buildings", { no: Number(no), name }),
    onSuccess: () => { invalidate(); onClose(); },
  });
  return (
    <Dialog open={open} onClose={onClose} title={building ? t("rooms.renameBuilding") : t("rooms.addBuilding")} size="sm"
      footer={<><Button onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>{t("common.save")}</Button></>}>
      <div className="space-y-3">
        <Field label={t("rooms.buildingNumber")} hint={t("rooms.buildingNumberHint")}>
          <Input type="number" min={0} max={15} value={no} disabled={!!building} onChange={(e) => setNo(e.target.value)} />
        </Field>
        <Field label={t("common.name")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("rooms.buildingPlaceholder")} /></Field>
        {save.isError && <Notice tone="red">{errorText(save.error)}</Notice>}
      </div>
    </Dialog>
  );
}

export default function Rooms() {
  const { meta } = useApp();
  const { t, errorText } = useI18n();
  const confirm = useConfirm();
  const invalidate = useInvalidateRooms();
  const buildings = useQuery({ queryKey: ["buildings"], queryFn: () => api.get<Building[]>("/v1/buildings") });
  const [selected, setSelected] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [dlg, setDlg] = useState<null | { kind: "room"; room: Room | null } | { kind: "batch" } | { kind: "building"; building: Building | null }>(null);
  const current = selected ?? buildings.data?.[0]?.no ?? null;
  const rooms = useQuery({
    queryKey: ["rooms", current], enabled: current !== null,
    queryFn: () => api.get<Room[]>("/v1/rooms", { building_no: current ?? undefined }),
  });
  const visible = (rooms.data ?? []).filter((r) => !q || r.room_no.includes(q) || r.room_type.toLowerCase().includes(q.toLowerCase()));
  const del = async (r: Room) => {
    if (!(await confirm({ title: t("rooms.confirmDelete", { room: r.room_no }), danger: true, confirmLabel: t("common.delete"), message: t("rooms.confirmDeleteText") }))) return;
    try { await api.del(`/v1/rooms/${r.id}`); toast.success(t("rooms.deleted", { room: r.room_no })); invalidate(); } catch (e) { toast.error(errorText(e)); }
  };
  const delBuilding = async (b: Building) => {
    if (!(await confirm({ title: t("rooms.confirmDeleteBuilding", { name: b.name }), danger: true, confirmLabel: t("rooms.deleteBuilding"),
      message: t("rooms.confirmDeleteBuildingText", { count: b.rooms }) }))) return;
    try { await api.del(`/v1/buildings/${b.no}`); setSelected(null); invalidate(); } catch (e) { toast.error(errorText(e)); }
  };

  if (buildings.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  const b = buildings.data?.find((x) => x.no === current);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t("nav.rooms")} description={t("rooms.intro")}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDlg({ kind: "building", building: null })}>{t("rooms.addBuilding")}</Button>} />
      {!buildings.data?.length ? (
        <Card><Empty icon={<Building2 className="size-6" />} title={t("rooms.noBuildings")} description={t("rooms.noBuildingsText")}
          action={<Button variant="primary" onClick={() => setDlg({ kind: "building", building: null })}>{t("rooms.addBuilding")}</Button>} /></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
          <Card className="p-2 h-fit">
            {buildings.data.map((x) => (
              <div key={x.no} className={clsx("group flex items-center gap-2 rounded-lg px-3 h-10 cursor-pointer",
                x.no === current ? "bg-primary-soft text-primary" : "hover:bg-surface-2")} onClick={() => setSelected(x.no)}>
                <Building2 className="size-4 shrink-0" />
                <span className="flex-1 truncate text-sm font-medium">{x.name}</span>
                <span className="text-xs text-muted tabular-nums">{x.rooms}</span>
              </div>
            ))}
          </Card>
          {b && (
            <Card>
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
                <div className="me-auto">
                  <div className="font-semibold">{b.name} <span className="text-muted font-normal">· {t("rooms.buildingNo", { no: b.no })}</span></div>
                  <div className="text-xs text-muted">{t("rooms.count", { count: b.rooms })}</div>
                </div>
                <div className="relative">
                  <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("rooms.find")} className="ps-9 w-44" />
                </div>
                <IconButton label={t("rooms.renameBuilding")} onClick={() => setDlg({ kind: "building", building: b })}><Pencil className="size-4" /></IconButton>
                <IconButton label={t("rooms.deleteBuilding")} onClick={() => delBuilding(b)}><Trash2 className="size-4" /></IconButton>
                <Button icon={<Layers className="size-4" />} onClick={() => setDlg({ kind: "batch" })}>{t("rooms.addBulk")}</Button>
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDlg({ kind: "room", room: null })}>{t("rooms.addRoom")}</Button>
              </div>
              {rooms.isLoading ? <div className="flex justify-center py-12"><Spinner /></div> : !visible.length ? (
                <Empty title={q ? t("board.noMatch") : t("rooms.emptyBuilding")} description={q ? undefined : t("rooms.emptyBuildingText")} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-start text-xs text-muted">
                      <tr className="border-b border-line">
                        {[t("common.room"), t("rooms.lockNo"), t("rooms.type"), t("common.price"), t("rooms.hourly"), t("rooms.maxCards"), ""].map((h, i) =>
                          <th key={i} className="px-4 py-2.5 font-medium text-start">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                          <td className="px-4 py-2.5 font-semibold tabular-nums">{r.room_no} {r.public_door && <Badge tone="blue">{t("rooms.public")}</Badge>}</td>
                          <td className="px-4 py-2.5 tabular-nums text-muted"><span dir="ltr">{r.building_no}-{r.floor_no}-{r.lock_room}</span></td>
                          <td className="px-4 py-2.5">{r.room_type}</td>
                          <td className="px-4 py-2.5 tabular-nums">{money(r.price, meta?.currency)}</td>
                          <td className="px-4 py-2.5 tabular-nums text-muted">{r.hour_start_price || r.hour_price
                            ? t("rooms.hourlyValue", { start: money(r.hour_start_price), extra: money(r.hour_price) }) : "—"}</td>
                          <td className="px-4 py-2.5 tabular-nums">{r.max_cards}</td>
                          <td className="px-4 py-2.5 text-end whitespace-nowrap">
                            <IconButton label={t("common.edit")} onClick={() => setDlg({ kind: "room", room: r })}><Pencil className="size-4" /></IconButton>
                            <IconButton label={t("common.delete")} onClick={() => del(r)}><Trash2 className="size-4" /></IconButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
      {current !== null && <RoomDialog open={dlg?.kind === "room"} onClose={() => setDlg(null)} building={current} room={dlg?.kind === "room" ? dlg.room : null} />}
      {current !== null && <BatchDialog open={dlg?.kind === "batch"} onClose={() => setDlg(null)} building={current} />}
      <BuildingDialog open={dlg?.kind === "building"} onClose={() => setDlg(null)} building={dlg?.kind === "building" ? dlg.building : null}
        used={buildings.data?.map((x) => x.no) ?? []} />
    </div>
  );
}
