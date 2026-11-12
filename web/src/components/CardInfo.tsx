import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleSlash, CreditCard, DoorOpen, Eraser, LogOut, ScanLine } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useI18n } from "../i18n";
import { api, type CardInspection, type Stay } from "../lib/api";
import { useApp } from "../lib/app";
import { cardShort, fmtDateTime } from "../lib/format";
import { useEncoderReady } from "./CardWriter";
import { useConfirm, Dialog } from "./Dialog";
import { Badge, Button, Kv, Notice, Spinner } from "./ui";

export function CardInfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { encoder, encoderId, meta, can } = useApp();
  const { t, tr, errorText } = useI18n();
  const { ready, reason } = useEncoderReady("read_card");
  const confirm = useConfirm();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [info, setInfo] = useState<CardInspection | null>(null);

  const read = useMutation({
    mutationFn: () => api.post<CardInspection>("/v1/cards/inspect", { encoder_id: encoderId }),
    onSuccess: setInfo,
    onError: () => setInfo(null),
  });
  const checkout = useMutation({
    mutationFn: () => api.post<Stay>("/v1/cards/checkout", { encoder_id: encoderId, erase: true }),
    onSuccess: (stay) => {
      toast.success(t("cardInfo.checkedOut", { room: stay.room.room_no }));
      ["board", "stay", "parties", "report"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      read.mutate();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const erase = useMutation({
    mutationFn: () => api.post<CardInspection>("/v1/cards/erase", { encoder_id: encoderId }),
    onSuccess: (r) => {
      toast.success(t("cardInfo.erased"));
      setInfo({ ...r, blank: true });
      ["board", "stay", "parties", "report"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const close = () => {
    setInfo(null);
    read.reset();
    onClose();
  };

  const stay = info?.stay;
  const card = info?.card;
  const activeGuest = card?.kind === "guest" && stay?.status === "active";
  const canErase = meta?.calibrated.erase_card && !info?.blank && (card?.kind === "guest" || !card || can("staff_cards"));

  return (
    <Dialog open={open} onClose={close} title={t("cardInfo.title")} icon={<ScanLine className="size-5" />}
      description={encoder ? tr("cardInfo.readsOn", { encoder: <b>{encoder.name}</b> }) : t("cardInfo.selectEncoder")}
      footer={<>
        <Button onClick={close}>{t("common.close")}</Button>
        <Button variant="primary" icon={<ScanLine className="size-4" />} loading={read.isPending}
          disabled={!ready} onClick={() => read.mutate()}>{info ? t("cardInfo.readAgain") : t("cardInfo.readCard")}</Button>
      </>}>
      {!ready && reason !== "uncalibrated" && (
        <Notice tone="amber">{reason === "no_encoder" ? t("cardInfo.chooseEncoder") : t("cardInfo.encoderOffline", { encoder: encoder?.name ?? "" })}</Notice>
      )}
      {read.isPending && <div className="flex items-center gap-3 py-8 justify-center text-sm text-muted"><Spinner /> {t("cardInfo.reading")}</div>}
      {read.isError && <Notice tone="red">{errorText(read.error)}</Notice>}
      {!info && !read.isPending && !read.isError && ready && (
        <div className="flex flex-col items-center py-8 text-center">
          <div className="rounded-full bg-primary-soft p-4 text-primary mb-3"><CreditCard className="size-7" /></div>
          <div className="font-medium">{t("cardInfo.placeCard")}</div>
          <div className="text-sm text-muted">{tr("cardInfo.thenPress", { button: <b>{t("cardInfo.readCard")}</b> })}</div>
        </div>
      )}
      {info && !read.isPending && (
        <div className="space-y-4">
          {info.blank ? (
            <div className="flex items-center gap-3 rounded-xl border border-line p-4">
              <CircleSlash className="size-6 text-muted" />
              <div><div className="font-medium">{t("cardInfo.blank")}</div><div className="text-sm text-muted">{t("cardInfo.blankText")}</div></div>
            </div>
          ) : (
            <div className="rounded-xl border border-line p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CreditCard className="size-5 text-primary" />
                  <span className="font-semibold">{card ? t(`cardKind.${card.kind}`) : t("cardInfo.unknown")}</span>
                </div>
                {card ? <Badge tone={card.status === "active" ? "green" : card.status === "expired" ? "amber" : "gray"}>{t(`cardStatus.${card.status}`)}</Badge>
                  : <Badge tone="amber">{t("cardInfo.foreign")}</Badge>}
              </div>
              <div className="mt-3 divide-y divide-line">
                {stay && <Kv label={t("common.room")}>{stay.room.room_no} · {stay.room.building_name}</Kv>}
                {stay && <Kv label={t("common.guest")}>{stay.guests[0]?.name ?? "—"}</Kv>}
                {stay && <Kv label={t("cardInfo.stay")}>{stay.status === "active" ? t("cardInfo.until", { time: fmtDateTime(stay.check_out) }) : t(`stayStatus.${stay.status}`)}</Kv>}
                {card?.holder && !stay && <Kv label={t("common.holder")}>{card.holder}</Kv>}
                {card?.valid_to && <Kv label={t("common.validUntil")}>{fmtDateTime(card.valid_to)}</Kv>}
                {card && <Kv label={t("cardInfo.issued")}>{fmtDateTime(card.issued_at)}</Kv>}
                {info.card_type_code !== null && <Kv label={t("cardInfo.typeCode")}><span dir="ltr">0x{info.card_type_code.toString(16).toUpperCase()}</span></Kv>}
                <Kv label={t("cardInfo.cardData")}><code dir="ltr" className="text-xs" title={info.card_data}>{cardShort(info.card_data)}</code></Kv>
              </div>
            </div>
          )}
          {!info.blank && (
            <div className="flex flex-wrap gap-2">
              {activeGuest && (
                <Button variant="primary" icon={<LogOut className="size-4 rtl:-scale-x-100" />} loading={checkout.isPending}
                  disabled={!meta?.calibrated.erase_card}
                  title={meta?.calibrated.erase_card ? undefined : t("cardInfo.eraseNotCalibrated")}
                  onClick={async () => {
                    if (await confirm({ title: t("cardInfo.confirmCheckout", { room: stay!.room.room_no }), confirmLabel: t("checkout.checkOut"),
                      message: t("cardInfo.confirmCheckoutText") })) checkout.mutate();
                  }}>{t("cardInfo.checkoutWithCard")}</Button>
              )}
              {stay && (
                <Button icon={<DoorOpen className="size-4" />} onClick={() => { close(); navigate(`/?room=${stay.room.id}`); }}>
                  {t("cardInfo.openRoom", { room: stay.room.room_no })}
                </Button>
              )}
              {canErase && (
                <Button variant="ghost" icon={<Eraser className="size-4" />} loading={erase.isPending}
                  onClick={async () => {
                    if (await confirm({ title: t("cardInfo.confirmErase"), danger: true, confirmLabel: t("cardInfo.erase"),
                      message: activeGuest ? t("cardInfo.confirmEraseGuest") : t("cardInfo.confirmEraseText") }))
                      erase.mutate();
                  }}>{t("cardInfo.eraseCard")}</Button>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
