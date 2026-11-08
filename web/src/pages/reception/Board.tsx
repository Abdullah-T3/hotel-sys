import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BedDouble, CalendarClock, CalendarPlus, CreditCard, LogIn, LogOut, Search, Star, Users, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { STATUS_STYLE } from "../../components/CardWriter";
import { Button, Empty, Input, PageHeader, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { api, type Board as BoardData, type BoardRoom, type RoomStatus } from "../../lib/api";
import { fmtShort } from "../../lib/format";
import { CheckInDialog, ReservationDialog, TeamDialog } from "./dialogs";
import { RoomDrawer } from "./RoomDrawer";

const ORDER: RoomStatus[] = ["VC", "VD", "OC", "TM", "OH", "OT", "TO", "OO"];

function RoomTile({ room, onOpen }: { room: BoardRoom; onOpen: () => void }) {
  const t = useT();
  const st = STATUS_STYLE[room.status];
  const s = room.stay;
  const r = room.reservation;
  return (
    <button type="button" onClick={onOpen} title={t(`status.${room.status}`)}
      className={clsx("group relative flex h-[104px] flex-col overflow-hidden rounded-xl border border-line bg-surface text-start shadow-xs",
        "transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        room.status === "TO" && "overdue-pulse border-st-to/60")}>
      <span className={clsx("absolute inset-x-0 top-0 h-1", st.bg)} />
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
        <div className="min-w-0">
          <div className="text-[17px] font-semibold leading-tight tabular-nums">{room.room_no}</div>
          <div className="text-[11px] text-muted truncate">{room.room_type}</div>
        </div>
        <span className={clsx("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white whitespace-nowrap", st.bg)}>
          {t(`statusShort.${room.status}`)}
        </span>
      </div>
      <div className="mt-auto px-3 pb-2.5 text-[12px] leading-snug min-w-0">
        {s ? (
          <>
            <div className="flex items-center gap-1 font-medium truncate">
              {s.vip && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
              {s.kind === "team" && <Users className="size-3 shrink-0 text-st-tm" />}
              <span className="truncate">{s.party_name && s.kind === "team" ? s.party_name : s.guest_name ?? "—"}</span>
            </div>
            <div className={clsx("flex items-center gap-1 tabular-nums", room.status === "TO" ? "text-st-to font-medium" : "text-muted")}>
              <LogOut className="size-3 rtl:-scale-x-100" /> {fmtShort(s.check_out)}
              <span className={clsx("ms-auto flex items-center gap-0.5", s.cards_issued === 0 ? "text-amber-600 font-medium" : "text-muted")}
                title={t("board.cardsIssued", { count: s.cards_issued })}>
                <CreditCard className="size-3" />{s.cards_issued}
              </span>
            </div>
          </>
        ) : r && room.status === "OT" ? (
          <>
            <div className="font-medium truncate text-st-ot">{r.party_name}</div>
            <div className="flex items-center gap-1 text-muted tabular-nums"><LogIn className="size-3 rtl:-scale-x-100" /> {fmtShort(r.check_in)}</div>
          </>
        ) : (
          <div className={clsx("text-muted", room.status === "OO" && "truncate")}>
            {room.status === "OO" ? room.maintenance_note || t("status.OO") : t(`status.${room.status}`)}
          </div>
        )}
      </div>
    </button>
  );
}

export default function Board() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<RoomStatus | null>(null);
  const [building, setBuilding] = useState<number | "all">("all");
  const [dialog, setDialog] = useState<null | "walkin" | "team" | "reserve">(null);

  const board = useQuery({ queryKey: ["board"], queryFn: () => api.get<BoardData>("/v1/reception/board"), refetchInterval: 10_000 });
  const rooms = useMemo(() => board.data?.rooms ?? [], [board.data]);
  const selectedId = Number(params.get("room")) || null;
  const selected = rooms.find((r) => r.id === selectedId) ?? null;
  const open = (id: number | null) => setParams(id ? { room: String(id) } : {}, { replace: true });

  const buildings = useMemo(() => {
    const m = new Map<number, string>();
    rooms.forEach((r) => m.set(r.building_no, r.building_name));
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [rooms]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rooms.filter((r) =>
      (building === "all" || r.building_no === building) &&
      (!filter || r.status === filter) &&
      (!needle || r.room_no.toLowerCase().includes(needle) ||
        (r.stay?.guest_name ?? "").toLowerCase().includes(needle) ||
        (r.stay?.party_name ?? "").toLowerCase().includes(needle) ||
        (r.reservation?.party_name ?? "").toLowerCase().includes(needle)));
  }, [rooms, q, filter, building]);

  const groups = useMemo(() => {
    const out = new Map<string, { title: string; rooms: BoardRoom[] }>();
    for (const r of visible) {
      const key = `${r.building_no}-${r.floor_no}`;
      if (!out.has(key)) {
        const floor = t("board.floor", { floor: r.floor_no });
        out.set(key, { title: buildings.length > 1 && building === "all" ? `${r.building_name} · ${floor}` : floor, rooms: [] });
      }
      out.get(key)!.rooms.push(r);
    }
    return [...out.values()];
  }, [visible, buildings.length, building, t]);

  if (board.isLoading) return <div className="flex justify-center py-20"><Spinner className="size-6" /></div>;
  const data = board.data!;

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader title={t("nav.reception")} description={t("board.summary", { count: rooms.length, time: fmtShort(data.now) })}
        actions={<>
          <Button icon={<CalendarPlus className="size-4" />} onClick={() => setDialog("reserve")}>{t("board.reservation")}</Button>
          <Button icon={<Users className="size-4" />} onClick={() => setDialog("team")}>{t("team.title")}</Button>
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setDialog("walkin")}>{t("checkin.title")}</Button>
        </>} />

      {rooms.length === 0 ? (
        <Empty icon={<BedDouble className="size-6" />} title={t("board.noRooms")} description={t("board.noRoomsText")}
          action={<Link to="/rooms"><Button variant="primary">{t("board.defineRooms")}</Button></Link>} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {ORDER.map((s) => (
              <button key={s} type="button" onClick={() => setFilter(filter === s ? null : s)} aria-pressed={filter === s}
                className={clsx("flex items-center gap-2 rounded-full border px-3 h-8 text-[13px] transition-colors",
                  filter === s ? "border-fg bg-fg text-bg" : "border-line bg-surface hover:bg-surface-2",
                  data.counts[s] === 0 && filter !== s && "opacity-50")}>
                <span className={clsx("size-2 rounded-full", STATUS_STYLE[s].dot)} />
                {t(`status.${s}`)}
                <span className="font-semibold tabular-nums">{data.counts[s]}</span>
              </button>
            ))}
            <div className="flex items-center gap-3 ms-auto text-[13px] text-muted">
              <span className="flex items-center gap-1"><LogIn className="size-3.5 rtl:-scale-x-100" /> {t("board.arrivals", { count: data.arrivals_today })}</span>
              <span className="flex items-center gap-1"><CalendarClock className="size-3.5" /> {t("board.departures", { count: data.departures_today })}</span>
            </div>
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-72">
              <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("board.search")} className="ps-9" />
            </div>
            {buildings.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {[["all", t("board.allBuildings")] as const, ...buildings].map(([no, name]) => (
                  <button key={no} type="button" onClick={() => setBuilding(no)}
                    className={clsx("rounded-lg px-3 h-8 text-[13px] font-medium",
                      building === no ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2")}>
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {groups.length === 0 ? (
            <Empty icon={<Search className="size-6" />} title={t("board.noMatch")} description={t("board.noMatchText")} />
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <section key={g.title}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{g.title}</h3>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2.5">
                    {g.rooms.map((r) => <RoomTile key={r.id} room={r} onOpen={() => open(r.id)} />)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <RoomDrawer room={selected} rooms={rooms} onClose={() => open(null)} />
      <CheckInDialog open={dialog === "walkin"} onClose={() => setDialog(null)} rooms={rooms} />
      <TeamDialog open={dialog === "team"} onClose={() => setDialog(null)} />
      <ReservationDialog open={dialog === "reserve"} onClose={() => setDialog(null)} />
    </div>
  );
}
