import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, CreditCard, Download, Printer, Search, Trash2, Upload, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CardStep } from "../components/CardWriter";
import { Dialog, useConfirm } from "../components/Dialog";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Select, Spinner, Tabs } from "../components/ui";
import { useI18n } from "../i18n";
import { api, type Card as CardT } from "../lib/api";
import { useApp } from "../lib/app";
import { downloadCsv } from "../lib/csv";
import { actorName, cardShort, fmtDateTime, money } from "../lib/format";
import { ID_TYPE_KEYS } from "./reception/dialogs";

type Tab = "cards" | "guests" | "open";

interface GuestRow {
  stay_id: number; room_no: string; name: string; sex: string | null; id_type: string | null; id_no: string | null; phone: string | null;
  kind: string; status: string; party_name: string | null; check_in: string; check_out: string; checked_out_at: string | null;
  price: number; deposit: number; vip: boolean; created_by: string | null; is_primary: number;
}
interface OpenRow { id: number; opened_at: string | null; room_label: string | null; card_kind: string | null; card_ref: string | null; raw: string; uploaded_at: string }

const STAY_TONE: Record<string, "blue" | "violet" | "gray" | "green"> = { active: "blue", reserved: "violet", checked_out: "gray", cancelled: "gray" };
const CARD_KINDS = ["guest", "master", "building", "floor", "emergency", "group", "checkout", "record", "loss", "authorization",
  "room_set", "clock_set", "group_set", "system"];
const CARD_STATUSES = ["active", "expired", "checked_out", "replaced", "erased", "lost"];
const STAY_STATUSES = ["active", "reserved", "checked_out", "cancelled"];

export default function Reports() {
  const { meta, can, encoderId } = useApp();
  const { t, errorText } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("cards");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [upload, setUpload] = useState(false);
  const [exporting, setExporting] = useState(false);

  const params = { q: q || undefined, date_from: from || undefined, date_to: to || undefined };
  const cardParams = { ...params, kind: kind || undefined, status: status || undefined };
  const guestParams = { ...params, status: status || undefined };
  const cards = useQuery({ queryKey: ["report", "cards", cardParams], enabled: tab === "cards",
    queryFn: () => api.get<CardT[]>("/v1/reports/cards", cardParams) });
  const guests = useQuery({ queryKey: ["report", "guests", guestParams], enabled: tab === "guests",
    queryFn: () => api.get<GuestRow[]>("/v1/reports/guests", guestParams) });
  const opens = useQuery({ queryKey: ["report", "open", params], enabled: tab === "open",
    queryFn: () => api.get<OpenRow[]>("/v1/reports/open-records", params) });

  const path = { cards: "/v1/reports/cards", guests: "/v1/reports/guests", open: "/v1/reports/open-records" }[tab];
  const cleanup = useMutation({
    mutationFn: () => api.post<{ deleted: number }>(`${path}/cleanup`),
    onSuccess: (r) => { toast.success(t("reports.deleted", { count: r.deleted })); qc.invalidateQueries({ queryKey: ["report"] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  const idType = (v: string | null) => (v ? (ID_TYPE_KEYS[v] ? t(`idType.${ID_TYPE_KEYS[v]}`) : v) : "");

  const exportCsv = async () => {
    setExporting(true);
    try {
      if (tab === "cards") {
        const rows = await api.get<CardT[]>(path, { ...cardParams, limit: 5000 });
        downloadCsv("card-records.csv",
          [t("reports.col.issued"), t("reports.col.type"), t("common.room"), t("common.holder"), t("common.validFrom"), t("common.validUntil"),
            t("common.status"), t("reports.col.operator"), t("reports.col.encoder"), t("cardInfo.cardData"), t("common.note")],
          rows.map((c) => [c.issued_at, t(`cardKind.${c.kind}`), c.room_no, c.holder, c.valid_from, c.valid_to, t(`cardStatus.${c.status}`),
            actorName(c.issued_by), c.encoder_id, c.card_data, c.note]));
      } else if (tab === "guests") {
        const rows = await api.get<GuestRow[]>(path, { ...guestParams, limit: 5000 });
        downloadCsv("guest-records.csv",
          [t("common.room"), t("common.guest"), t("guest.sex"), t("guest.idType"), t("guest.idNumber"), t("guest.phone"), t("reports.col.type"),
            t("common.status"), t("reports.col.group"), t("drawer.checkIn"), t("stay.checkOut"), t("reports.col.checkedOutAt"),
            t("common.price"), t("common.deposit"), t("reports.col.operator")],
          rows.map((g) => [g.room_no, g.name, g.sex ? t(g.sex === "M" ? "guest.male" : "guest.female") : "", idType(g.id_type), g.id_no, g.phone,
            t(`stayKind.${g.kind}`), t(`stayStatus.${g.status}`), g.party_name, g.check_in, g.check_out, g.checked_out_at,
            g.is_primary ? g.price : "", g.is_primary ? g.deposit : "", actorName(g.created_by)]));
      } else {
        const rows = await api.get<OpenRow[]>(path, { ...params, limit: 10000 });
        downloadCsv("door-open-records.csv",
          [t("reports.col.openedAt"), t("common.room"), t("reports.col.card"), t("reports.col.cardRef"), t("reports.col.uploaded"), t("reports.col.raw")],
          rows.map((o) => [o.opened_at, o.room_label, o.card_kind, o.card_ref, o.uploaded_at, o.raw]));
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setExporting(false);
    }
  };
  const loading = (tab === "cards" && cards.isLoading) || (tab === "guests" && guests.isLoading) || (tab === "open" && opens.isLoading);
  const th = (labels: string[]) => (
    <thead className="text-xs text-muted"><tr className="border-b border-line">
      {labels.map((h, i) => <th key={i} className="px-4 py-2.5 font-medium text-start">{h}</th>)}
    </tr></thead>
  );

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title={t("nav.reports")} description={t("reports.intro")}
        actions={<>
          {tab === "open" && <Button icon={<Upload className="size-4" />} onClick={() => setUpload(true)}>{t("reports.uploadRecord")}</Button>}
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>{t("reports.print")}</Button>
          {can("reports_manage") && (
            <Button icon={<Download className="size-4" />} loading={exporting} onClick={exportCsv}>{t("reports.export")}</Button>
          )}
          {can("reports_manage") && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={cleanup.isPending}
              onClick={async () => { if (await confirm({ title: t("reports.cleanupTitle"), message: t(`reports.cleanup.${tab}`), danger: true, confirmLabel: t("common.delete") })) cleanup.mutate(); }}>
              {t("reports.cleanupButton")}</Button>
          )}
        </>} />
      <Card>
        <div className="px-4 no-print">
          <Tabs value={tab} onChange={(v) => { setTab(v); setStatus(""); }} tabs={[
            { value: "cards", label: t("reports.tab.cards"), icon: <CreditCard className="size-4" /> },
            { value: "guests", label: t("reports.tab.guests"), icon: <Users className="size-4" /> },
            { value: "open", label: t("reports.tab.open"), icon: <ClipboardList className="size-4" /> },
          ]} />
        </div>
        <div className="no-print flex flex-wrap items-end gap-3 p-4 border-b border-line">
          <Field label={t("common.search")} className="w-full sm:w-64">
            <div className="relative"><Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "guests" ? t("reports.searchGuests") : t("reports.searchCards")} className="ps-9" /></div>
          </Field>
          <Field label={t("reports.from")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={t("reports.to")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          {tab === "cards" && (
            <Field label={t("reports.col.type")}>
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">{t("reports.allTypes")}</option>
                {CARD_KINDS.map((k) => <option key={k} value={k}>{t(`cardKind.${k}`)}</option>)}
              </Select>
            </Field>
          )}
          {tab !== "open" && (
            <Field label={t("common.status")}>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t("common.any")}</option>
                {tab === "cards"
                  ? CARD_STATUSES.map((k) => <option key={k} value={k}>{t(`cardStatus.${k}`)}</option>)
                  : STAY_STATUSES.map((k) => <option key={k} value={k}>{t(`stayStatus.${k}`)}</option>)}
              </Select>
            </Field>
          )}
        </div>

        {loading ? <div className="flex justify-center py-16"><Spinner /></div> : (
          <div className="overflow-x-auto">
            {tab === "cards" && (cards.data?.length ? (
              <table className="w-full text-sm">
                {th([t("reports.col.issued"), t("reports.col.type"), t("reports.col.roomHolder"), t("common.validUntil"), t("common.status"), t("reports.col.operator"), t("reports.col.card")])}
                <tbody>{cards.data.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(c.issued_at)}</td>
                    <td className="px-4 py-2">{t(`cardKind.${c.kind}`)}</td>
                    <td className="px-4 py-2">{c.room_no && <b className="me-1.5">{c.room_no}</b>}{c.holder}{c.note && <span className="text-muted"> · {c.note}</span>}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(c.valid_to)}</td>
                    <td className="px-4 py-2"><Badge tone={c.status === "active" ? "green" : c.status === "expired" ? "amber" : c.status === "lost" ? "red" : "gray"}>{t(`cardStatus.${c.status}`)}</Badge></td>
                    <td className="px-4 py-2 text-muted">{actorName(c.issued_by)}</td>
                    <td className="px-4 py-2"><code dir="ltr" className="text-xs text-muted" title={c.card_data ?? ""}>{cardShort(c.card_data)}</code></td>
                  </tr>))}</tbody>
              </table>
            ) : <Empty icon={<CreditCard className="size-5" />} title={t("reports.noCards")} />)}

            {tab === "guests" && (guests.data?.length ? (
              <table className="w-full text-sm">
                {th([t("common.room"), t("common.guest"), t("guest.id"), t("guest.phone"), t("drawer.checkIn"), t("stay.checkOut"), t("common.status"), t("common.price"), t("reports.col.operator")])}
                <tbody>{guests.data.map((g, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-semibold">{g.room_no}</td>
                    <td className="px-4 py-2">{g.name}{!g.is_primary && <span className="text-muted"> ({t("reports.companion")})</span>}{g.party_name && <div className="text-xs text-muted">{g.party_name}</div>}</td>
                    <td className="px-4 py-2 text-muted">{g.id_no ? `${idType(g.id_type)} ${g.id_no}` : "—"}</td>
                    <td className="px-4 py-2 text-muted"><span dir="ltr">{g.phone ?? "—"}</span></td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(g.check_in)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(g.checked_out_at ?? g.check_out)}</td>
                    <td className="px-4 py-2"><Badge tone={STAY_TONE[g.status] ?? "gray"}>{t(`stayStatus.${g.status}`)}</Badge></td>
                    <td className="px-4 py-2 tabular-nums">{g.is_primary ? money(g.price, meta?.currency) : ""}</td>
                    <td className="px-4 py-2 text-muted">{actorName(g.created_by)}</td>
                  </tr>))}</tbody>
              </table>
            ) : <Empty icon={<Users className="size-5" />} title={t("reports.noGuests")} />)}

            {tab === "open" && (opens.data?.length ? (
              <table className="w-full text-sm">
                {th([t("reports.col.openedAt"), t("common.room"), t("reports.col.card"), t("reports.col.cardRef"), t("reports.col.uploaded")])}
                <tbody>{opens.data.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">{o.opened_at ? fmtDateTime(o.opened_at) : <code dir="ltr" className="text-xs">{o.raw}</code>}</td>
                    <td className="px-4 py-2 font-semibold">{o.room_label ?? "—"}</td>
                    <td className="px-4 py-2">{o.card_kind ? t(`cardKind.${o.card_kind}`) : "—"}</td>
                    <td className="px-4 py-2 text-muted">{o.card_ref ?? "—"}</td>
                    <td className="px-4 py-2 text-muted">{fmtDateTime(o.uploaded_at)}</td>
                  </tr>))}</tbody>
              </table>
            ) : <Empty icon={<ClipboardList className="size-5" />} title={t("reports.noOpen")} description={t("reports.noOpenText")}
                action={<Button onClick={() => setUpload(true)} icon={<Upload className="size-4" />}>{t("reports.uploadRecord")}</Button>} />)}
          </div>
        )}
      </Card>

      <Dialog open={upload} onClose={() => setUpload(false)} title={t("reports.uploadTitle")} icon={<Upload className="size-5" />}
        description={t("reports.uploadText")} footer={<Button onClick={() => setUpload(false)}>{t("common.close")}</Button>}>
        <CardStep op="read_record" actionLabel={t("reports.readRecord")} doneLabel={t("reports.uploaded")}
          instruction={t("reports.placeRecord")}
          run={() => api.post<{ uploaded: number }>("/v1/reports/open-records/upload", { encoder_id: encoderId })}
          successContent={(r) => <div className="text-xs text-muted">{t("reports.recordsAdded", { count: r.uploaded })}</div>}
          onDone={() => qc.invalidateQueries({ queryKey: ["report", "open"] })} />
      </Dialog>
    </div>
  );
}
