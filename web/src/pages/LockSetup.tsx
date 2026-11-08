import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Clock, Cog, DoorOpen, Hash, Info, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { CardStep } from "../components/CardWriter";
import { Badge, Card, CardHeader, Field, Input, Notice, PageHeader, Segmented, Select } from "../components/ui";
import { useI18n } from "../i18n";
import { api, type Card as CardT, type HotelSettings, type Room } from "../lib/api";
import { useApp } from "../lib/app";
import { toLocalInput } from "../lib/format";

type Kind = "authorization" | "room_set" | "clock_set" | "group_set" | "system";

const ITEMS: { kind: Kind; icon: ReactNode }[] = [
  { kind: "authorization", icon: <ShieldCheck className="size-4" /> },
  { kind: "room_set", icon: <DoorOpen className="size-4" /> },
  { kind: "clock_set", icon: <Clock className="size-4" /> },
  { kind: "group_set", icon: <Hash className="size-4" /> },
  { kind: "system", icon: <Cog className="size-4" /> },
];

const GROUP_ACTIONS = ["clear_all", "set_one", "clear_one", "set_all"] as const;
const GROUP_LABEL = { clear_all: "clearAll", set_one: "setOne", clear_one: "clearOne", set_all: "setAll" } as const;
export const LOCK_OPTION_KEYS = ["alarm", "remind_close", "no_disturb", "release_handle_lock", "music", "disable_cover"] as const;

export default function LockSetup() {
  const { encoderId, meta } = useApp();
  const { t, tr } = useI18n();
  const [kind, setKind] = useState<Kind>("authorization");
  const [roomId, setRoomId] = useState<number | "">("");
  const [clock, setClock] = useState("");
  const [groupAction, setGroupAction] = useState<(typeof GROUP_ACTIONS)[number]>("clear_all");
  const [groupNo, setGroupNo] = useState("1");
  const [stepKey, setStepKey] = useState(0);
  const rooms = useQuery({ queryKey: ["rooms", "all"], queryFn: () => api.get<Room[]>("/v1/rooms") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<HotelSettings>("/v1/settings"), enabled: kind === "system" });
  const title = t(`cardKind.${kind}`);
  const room = rooms.data?.find((r) => r.id === roomId);
  const needsGroupNo = groupAction === "set_one" || groupAction === "clear_one";
  const valid = kind !== "room_set" || roomId !== "";

  const run = () => api.post<CardT>("/v1/lock-setup", {
    encoder_id: encoderId, kind, room_id: kind === "room_set" ? roomId : undefined, clock: kind === "clock_set" && clock ? clock : undefined,
    group_action: kind === "group_set" ? groupAction : undefined, group_no: kind === "group_set" && needsGroupNo ? Number(groupNo) : undefined,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t("nav.lockSetup")} description={t("lock.intro")} />
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Card className="p-2 h-fit">
          {ITEMS.map((i) => (
            <button key={i.kind} type="button" onClick={() => { setKind(i.kind); setStepKey((k) => k + 1); }}
              className={clsx("flex w-full items-center gap-2.5 rounded-lg px-3 h-10 text-sm font-medium text-start",
                kind === i.kind ? "bg-primary-soft text-primary" : "hover:bg-surface-2")}>
              {i.icon}<span className="flex-1">{t(`cardKind.${i.kind}`)}</span>
              {meta?.calibrated[`issue_${i.kind}`] === false && <span className="size-1.5 rounded-full bg-amber-500" title={t("calibration.notCalibrated")} />}
            </button>
          ))}
        </Card>
        <Card>
          <CardHeader title={title} />
          <div className="p-5 space-y-4">
            <Notice tone="blue" icon={<Info className="size-4" />}>
              {kind === "authorization" ? tr("lock.about.authorization", { times: <b>{t("lock.threeTimes")}</b> }) : t(`lock.about.${kind}`)}
            </Notice>
            {kind === "room_set" && (
              <Field label={t("common.room")} required>
                <Select value={roomId} onChange={(e) => setRoomId(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">{t("lock.chooseRoom")}</option>
                  {rooms.data?.map((r) => <option key={r.id} value={r.id}>{r.room_no} · {r.building_name} ({t("lock.lockNo", { no: `${r.building_no}-${r.floor_no}-${r.lock_room}` })})</option>)}
                </Select>
              </Field>
            )}
            {room && <div className="text-[13px] text-muted">{t("lock.roomWillBe", { building: room.building_no, floor: room.floor_no, room: room.lock_room })}</div>}
            {kind === "clock_set" && (
              <Field label={t("lock.timeToWrite")} hint={t("lock.timeHint")} className="max-w-xs">
                <Input type="datetime-local" value={clock} placeholder={toLocalInput(new Date())} onChange={(e) => setClock(e.target.value)} />
              </Field>
            )}
            {kind === "group_set" && (
              <div className="space-y-3">
                <Segmented value={groupAction} onChange={setGroupAction} options={GROUP_ACTIONS.map((a) => ({ value: a, label: t(`lock.group.${GROUP_LABEL[a]}`) }))} />
                {needsGroupNo && (
                  <Field label={t("staff.groupNumber")} hint="0–255" className="max-w-40">
                    <Input type="number" min={0} max={255} value={groupNo} onChange={(e) => setGroupNo(e.target.value)} />
                  </Field>
                )}
              </div>
            )}
            {kind === "system" && settings.data && (
              <div className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap gap-1.5">
                  {LOCK_OPTION_KEYS.map((k) => (
                    <Badge key={k} tone={settings.data.lock_options[k] ? "green" : "gray"}>{settings.data.lock_options[k] ? t("common.on") : t("common.off")} · {t(`lockOption.${k}.label`)}</Badge>
                  ))}
                  <Badge tone={settings.data.guest_opens_deadbolt ? "green" : "gray"}>{settings.data.guest_opens_deadbolt ? t("common.on") : t("common.off")} · {t("lockOption.guest_deadbolt.label")}</Badge>
                </div>
                <Link to="/settings/general" className="mt-2 inline-block text-[13px] text-primary underline">{t("lock.changeOptions")}</Link>
              </div>
            )}
            <CardStep key={stepKey} op={`issue_${kind}`} actionLabel={t("staff.write", { card: title })} disabled={!valid}
              disabledReason={t("lock.chooseRoom")} run={run}
              onDone={() => { toast.success(t("lock.written", { card: title })); setTimeout(() => setStepKey((k) => k + 1), 2500); }} />
          </div>
        </Card>
      </div>
    </div>
  );
}
