import { useInfiniteQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button, Card, CardHeader, Input, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { api, type AuditEntry } from "../../lib/api";
import { actorName, fmtDateTime, toLocalInput } from "../../lib/format";

function summary(e: AuditEntry) {
  const r = e.request as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return e.detail ?? "";
  const keys = ["room", "room_no", "guest", "stay_id", "from", "to", "username", "name", "kind", "holder", "fn", "rooms"];
  const bits = keys.filter((k) => r[k] !== undefined && r[k] !== null).map((k) => `${k}: ${Array.isArray(r[k]) ? (r[k] as unknown[]).join(",") : String(r[k])}`);
  return [bits.join(" · "), e.detail].filter(Boolean).join(" — ");
}

export default function Audit() {
  const t = useT();
  const [encoder, setEncoder] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["audit", encoder],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.get<AuditEntry[]>("/v1/audit", { limit: 100, encoder_id: encoder || undefined, before_id: pageParam }),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <Card>
      <CardHeader title={t("settings.tab.audit")} description={t("audit.intro")}
        actions={<Input className="w-48" placeholder={t("audit.filter")} value={encoder} onChange={(e) => setEncoder(e.target.value)} />} />
      {q.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr className="border-b border-line">
              {["", t("audit.time"), t("audit.who"), t("audit.action"), t("reports.col.encoder"), t("audit.details")].map((h, i) =>
                <th key={i} className="px-4 py-2.5 font-medium text-start">{h}</th>)}
            </tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0">
                <td className="ps-4 py-2">{e.ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-red-500" />}</td>
                <td className="px-4 py-2 whitespace-nowrap text-muted">{fmtDateTime(toLocalInput(new Date(e.ts)))}</td>
                <td className="px-4 py-2 whitespace-nowrap">{actorName(e.actor)}</td>
                <td className="px-4 py-2 whitespace-nowrap"><code className="text-xs">{e.action}</code></td>
                <td className="px-4 py-2 text-muted">{e.encoder_id ?? ""}</td>
                <td className="px-4 py-2 text-muted max-w-md truncate" title={summary(e)}>{summary(e)}{e.ret !== null && e.ret !== 0 ? ` (${t("audit.code", { code: e.ret })})` : ""}</td>
              </tr>
            ))}</tbody>
          </table>
          {q.hasNextPage && <div className="p-3 text-center"><Button size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("audit.loadMore")}</Button></div>}
        </div>
      )}
    </Card>
  );
}
