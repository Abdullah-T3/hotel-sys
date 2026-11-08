import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertOctagon, Building2, ClipboardList, DoorClosed, KeyRound, Layers, Lock, LogOut, Search, ShieldAlert, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CardStep } from "../components/CardWriter";
import { Badge, Button, Card, CardHeader, Checkbox, Empty, Field, Input, Notice, PageHeader, Select } from "../components/ui";
import { useT } from "../i18n";
import { api, type Building, type Card as CardT } from "../lib/api";
import { useApp } from "../lib/app";
import { cardShort, fmtDate, fmtDateTime, toLocalInput } from "../lib/format";

type Kind = "floor" | "building" | "master" | "emergency" | "group" | "checkout" | "record" | "loss";

const KINDS: { kind: Kind; icon: ReactNode; master?: boolean }[] = [
  { kind: "floor", icon: <Layers className="size-4" /> },
  { kind: "building", icon: <Building2 className="size-4" /> },
  { kind: "master", icon: <KeyRound className="size-4" />, master: true },
  { kind: "emergency", icon: <ShieldAlert className="size-4" />, master: true },
  { kind: "group", icon: <Users className="size-4" /> },
  { kind: "checkout", icon: <LogOut className="size-4 rtl:-scale-x-100" /> },
  { kind: "record", icon: <ClipboardList className="size-4" /> },
  { kind: "loss", icon: <AlertOctagon className="size-4" /> },
];
const PRESETS = [["day", 1], ["week", 7], ["month", 30], ["quarter", 90], ["year", 365]] as const;

function addDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 0, 0);
  return toLocalInput(d);
}

export default function StaffCards() {
  const { can, encoderId, meta } = useApp();
  const t = useT();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("floor");
  const [holder, setHolder] = useState("");
  const [validTo, setValidTo] = useState(addDays(30));
  const [timeFrom, setTimeFrom] = useState("00:00");
  const [timeTo, setTimeTo] = useState("23:59");
  const [buildingNo, setBuildingNo] = useState<number | "">("");
  const [floorNo, setFloorNo] = useState("1");
  const [groupNo, setGroupNo] = useState("1");
  const [cover, setCover] = useState(true);
  const [note, setNote] = useState("");
  const [lossQ, setLossQ] = useState("");
  const [target, setTarget] = useState<CardT | null>(null);
  const [stepKey, setStepKey] = useState(0);

  const buildings = useQuery({ queryKey: ["buildings"], queryFn: () => api.get<Building[]>("/v1/buildings") });
  const recent = useQuery({ queryKey: ["cards", kind], queryFn: () => api.get<CardT[]>("/v1/reports/cards", { kind, limit: 20 }) });
  const lossCandidates = useQuery({
    queryKey: ["cards", "loss-candidates", lossQ], enabled: kind === "loss",
    queryFn: () => api.get<CardT[]>("/v1/reports/cards", { status: "active", q: lossQ || undefined, limit: 30 }),
  });
  useEffect(() => { if (buildingNo === "" && buildings.data?.length) setBuildingNo(buildings.data[0].no); }, [buildings.data, buildingNo]);
  useEffect(() => { setTarget(null); setStepKey((k) => k + 1); }, [kind]);

  const info = KINDS.find((k) => k.kind === kind)!;
  const title = t(`cardKind.${kind}`);
  const allowed = info.master ? can("staff_cards_master") : can("staff_cards");
  const needsBuilding = kind === "floor" || kind === "building";
  const valid = holder.trim() && new Date(validTo) > new Date() && (!needsBuilding || buildingNo !== "") && (kind !== "loss" || target);

  const run = () => api.post<CardT>("/v1/staff-cards", {
    encoder_id: encoderId, kind, holder: holder.trim(), valid_to: validTo, time_from: timeFrom, time_to: timeTo,
    building_no: needsBuilding ? buildingNo : undefined, floor_no: kind === "floor" ? Number(floorNo) : undefined,
    group_no: kind === "group" ? Number(groupNo) : undefined, target_card_id: kind === "loss" ? target?.id : undefined,
    cover, note: note.trim() || undefined,
  });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t("nav.staffCards")} description={t("staff.intro")} />
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Card className="p-2 h-fit">
          {KINDS.map((k) => {
            const locked = k.master ? !can("staff_cards_master") : !can("staff_cards");
            return (
              <button key={k.kind} type="button" onClick={() => setKind(k.kind)}
                className={clsx("flex w-full items-center gap-2.5 rounded-lg px-3 h-10 text-sm font-medium text-start",
                  kind === k.kind ? "bg-primary-soft text-primary" : "hover:bg-surface-2", locked && "opacity-60")}>
                {k.icon}<span className="flex-1">{t(`cardKind.${k.kind}`)}</span>
                {locked && <Lock className="size-3.5 text-muted" />}
                {meta?.calibrated[`issue_${k.kind}`] === false && <span className="size-1.5 rounded-full bg-amber-500" title={t("calibration.notCalibrated")} />}
              </button>
            );
          })}
        </Card>

        <div className="space-y-5 min-w-0">
          <Card>
            <CardHeader title={title} description={t(`staff.about.${kind}`)} />
            <div className="p-5 space-y-4">
              {!allowed ? (
                <Notice tone="gray" icon={<Lock className="size-4" />}>{t("staff.notAllowed", { card: title })}</Notice>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label={t("staff.holder")} required><Input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder={t("staff.holderPlaceholder")} /></Field>
                    <Field label={t("common.validUntil")} required><Input type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></Field>
                  </div>
                  <div className="flex flex-wrap gap-1.5 -mt-1">
                    {PRESETS.map(([key, d]) => <Button key={key} size="sm" variant="ghost" onClick={() => setValidTo(addDays(d))}>{t(`staff.preset.${key}`)}</Button>)}
                  </div>
                  {kind !== "record" && kind !== "loss" && kind !== "checkout" && (
                    <div className="grid grid-cols-2 gap-3 max-w-sm">
                      <Field label={t("staff.dailyFrom")}><Input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} /></Field>
                      <Field label={t("staff.dailyUntil")}><Input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} /></Field>
                    </div>
                  )}
                  {needsBuilding && (
                    <div className="grid grid-cols-2 gap-3 max-w-md">
                      <Field label={t("staff.building")}>
                        <Select value={buildingNo} onChange={(e) => setBuildingNo(Number(e.target.value))}>
                          {buildings.data?.map((b) => <option key={b.no} value={b.no}>{b.no} · {b.name}</option>)}
                        </Select>
                      </Field>
                      {kind === "floor" && <Field label={t("rooms.floor")}><Input type="number" min={0} max={98} value={floorNo} onChange={(e) => setFloorNo(e.target.value)} /></Field>}
                    </div>
                  )}
                  {kind === "group" && (
                    <Field label={t("staff.groupNumber")} hint="0–255" className="max-w-40"><Input type="number" min={0} max={255} value={groupNo} onChange={(e) => setGroupNo(e.target.value)} /></Field>
                  )}
                  {kind === "loss" && (
                    <Field label={t("staff.lostCard")} required group>
                      <div className="relative mb-2">
                        <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                        <Input value={lossQ} onChange={(e) => setLossQ(e.target.value)} placeholder={t("staff.lostSearch")} className="ps-9" />
                      </div>
                      <div className="max-h-56 overflow-y-auto rounded-lg border border-line divide-y divide-line">
                        {lossCandidates.data?.filter((c) => c.kind !== "loss").map((c) => (
                          <button key={c.id} type="button" onClick={() => setTarget(c)}
                            className={clsx("flex w-full items-center gap-3 px-3 py-2 text-start text-sm", target?.id === c.id ? "bg-primary-soft" : "hover:bg-surface-2")}>
                            <Badge>{t(`cardKind.${c.kind}`)}</Badge>
                            <span className="font-medium truncate">{c.holder ?? "—"}</span>
                            {c.room_no && <span className="text-muted">{t("drawer.room", { room: c.room_no })}</span>}
                            <span className="ms-auto text-xs text-muted">{fmtDate(c.issued_at)}</span>
                          </button>
                        ))}
                        {!lossCandidates.data?.length && <div className="p-3 text-sm text-muted">{t("staff.noActiveCards")}</div>}
                      </div>
                    </Field>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
                    <Field label={t("common.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                    {!["record", "loss"].includes(kind) && (
                      <Checkbox checked={cover} onChange={setCover} className="h-9" label={t("staff.cover")} />
                    )}
                  </div>
                  <CardStep key={stepKey} op={`issue_${kind}`} actionLabel={t("staff.write", { card: title })} disabled={!valid}
                    disabledReason={!holder.trim() ? t("staff.needHolder") : kind === "loss" && !target ? t("staff.needLostCard") : t("staff.checkDates")}
                    run={run} successContent={(c) => <div className="text-xs text-muted mt-0.5">{t("staff.written", { holder: c.holder ?? "", time: fmtDateTime(c.valid_to) })}</div>}
                    onDone={() => { toast.success(t("staff.writtenToast", { card: title })); qc.invalidateQueries({ queryKey: ["cards"] }); setTimeout(() => setStepKey((k) => k + 1), 2500); }} />
                </>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title={t("staff.recent", { card: title })} />
            {!recent.data?.length ? <Empty icon={<DoorClosed className="size-5" />} title={t("staff.noneIssued")} /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted"><tr className="border-b border-line">
                    {[t("common.holder"), t("staff.scope"), t("common.validUntil"), t("common.status"), t("cardInfo.issued"), t("cardInfo.cardData")].map((h, i) =>
                      <th key={i} className="px-4 py-2.5 font-medium text-start">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {recent.data.map((c) => (
                      <tr key={c.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5 font-medium">{c.holder}</td>
                        <td className="px-4 py-2.5 text-muted">{[
                          c.building_no !== null ? t("staff.scopeBuilding", { no: c.building_no }) : "",
                          c.floor_no !== null ? t("staff.scopeFloor", { no: c.floor_no }) : "",
                          c.group_no !== null ? t("staff.scopeGroup", { no: c.group_no }) : "",
                          c.time_from && c.time_from !== "00:00" ? `${c.time_from}–${c.time_to}` : "",
                        ].filter(Boolean).join(" · ")}</td>
                        <td className="px-4 py-2.5">{fmtDateTime(c.valid_to)}</td>
                        <td className="px-4 py-2.5"><Badge tone={c.status === "active" ? "green" : c.status === "lost" ? "red" : "gray"}>{t(`cardStatus.${c.status}`)}</Badge></td>
                        <td className="px-4 py-2.5 text-muted">{fmtDate(c.issued_at)}</td>
                        <td className="px-4 py-2.5"><code dir="ltr" className="text-xs text-muted">{cardShort(c.card_data)}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
