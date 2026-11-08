import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Play, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "../../components/Dialog";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Spinner, Textarea } from "../../components/ui";
import { useI18n } from "../../i18n";
import { api, ApiError, type Template } from "../../lib/api";
import { useApp } from "../../lib/app";

interface InvokeOut { ret: number; outs: string[]; outs_text: string[] }

export default function Calibration() {
  const { encoderId, encoder, meta } = useApp();
  const { t, tr, errorText } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<Record<string, Template>>("/v1/templates") });
  const [fn, setFn] = useState("ReadCard");
  const [args, setArgs] = useState('[["i", 1], ["o", 128]]');
  const [result, setResult] = useState<InvokeOut | null>(null);

  const invoke = useMutation({
    mutationFn: () => api.post<InvokeOut>(`/v1/encoders/${encoderId}/invoke`, { fn, args: JSON.parse(args) }),
    onSuccess: setResult,
    onError: (e: Error) => toast.error(e instanceof ApiError ? errorText(e) : t("calibration.badArgs", { message: e.message })),
  });
  const mark = useMutation({
    mutationFn: ({ name, calibrated }: { name: string; calibrated: boolean }) => api.patch(`/v1/templates/${name}`, { calibrated }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["templates"] }); qc.invalidateQueries({ queryKey: ["meta"] }); },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <div className="space-y-5">
      <Notice tone="blue" icon={<Wrench className="size-4" />}>
        {tr("calibration.intro", { doc: <b dir="ltr">docs/CALIBRATION.md</b> })}
        {meta?.allow_uncalibrated && <> <b>{t("calibration.testingMode")}</b></>}
      </Notice>
      <Card>
        <CardHeader title={t("calibration.templates")} />
        {templates.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted"><tr className="border-b border-line">
                {[t("calibration.operation"), t("calibration.function"), t("calibration.arguments"), t("common.status"), ""].map((h, i) =>
                  <th key={i} className="px-4 py-2.5 font-medium text-start">{h}</th>)}
              </tr></thead>
              <tbody>{Object.entries(templates.data ?? {}).map(([name, tpl]) => (
                <tr key={name} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-2.5"><div className="font-medium">{t(`op.${name}`)}</div><code className="text-[11px] text-muted" dir="ltr">{name}</code></td>
                  <td className="px-4 py-2.5"><code className="text-xs" dir="ltr">{tpl.fn}</code></td>
                  <td className="px-4 py-2.5"><code dir="ltr" className="text-[11px] text-muted break-all">{tpl.args.map(([k, v]) => `${k}:${v}`).join("  ")}</code></td>
                  <td className="px-4 py-2.5">{tpl.calibrated ? <Badge tone="green"><CheckCircle2 className="size-3" />{t("calibration.calibrated")}</Badge> : <Badge tone="amber">{t("calibration.notCalibrated")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-end">
                    <Button size="sm" variant={tpl.calibrated ? "ghost" : "secondary"} onClick={async () => {
                      if (!tpl.calibrated && !(await confirm({ title: t("calibration.confirmMark", { op: t(`op.${name}`) }), confirmLabel: t("calibration.mark"),
                        message: t("calibration.confirmMarkText") }))) return;
                      mark.mutate({ name, calibrated: !tpl.calibrated });
                    }}>{tpl.calibrated ? t("calibration.unmark") : t("calibration.mark")}</Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title={t("calibration.console")} description={encoder ? t("calibration.consoleOn", { encoder: encoder.name }) : t("cardInfo.chooseEncoder")} />
        <div className="p-5 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
            <Field label={t("calibration.function")}><Input dir="ltr" value={fn} onChange={(e) => setFn(e.target.value)} /></Field>
            <Field label={t("calibration.argsLabel")}><Textarea dir="ltr" className="font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} /></Field>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" icon={<Play className="size-4" />} loading={invoke.isPending} disabled={!encoder?.online} onClick={() => invoke.mutate()}>{t("calibration.run")}</Button>
          </div>
          {result && (
            <pre dir="ltr" className="rounded-lg bg-surface-2 border border-line p-3 text-xs overflow-x-auto">
              {`ret = ${result.ret}${result.ret === 0 ? " (ok)" : ""}\n`}
              {result.outs_text.map((txt, i) => `out[${i}] text = ${JSON.stringify(txt)}\nout[${i}] hex  = ${result.outs[i].replace(/(00)+$/, "")}\n`).join("")}
            </pre>
          )}
        </div>
      </Card>
    </div>
  );
}
