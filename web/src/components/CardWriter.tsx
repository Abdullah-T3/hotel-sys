import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, RotateCcw, Usb, WifiOff, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useI18n, useT } from "../i18n";
import { ApiError, type RoomStatus } from "../lib/api";
import { useApp } from "../lib/app";
import { Badge, Button, Notice, Select } from "./ui";

// ------------------------------------------------------------------------------------- encoder readiness
export function useEncoderReady(op?: string) {
  const { encoder, meta } = useApp();
  if (!encoder) return { ready: false, reason: "no_encoder" as const };
  if (!encoder.enabled) return { ready: false, reason: "disabled" as const };
  if (!encoder.online) return { ready: false, reason: "offline" as const };
  if (op && meta && meta.calibrated[op] === false) return { ready: false, reason: "uncalibrated" as const };
  return { ready: true, reason: null };
}

export function EncoderPicker({ compact }: { compact?: boolean }) {
  const { encoders, encoderId, setEncoderId, encoder } = useApp();
  const t = useT();
  if (!encoders.length) {
    return compact ? <Badge tone="gray"><Usb className="size-3" /> {t("encoder.none")}</Badge> : null;
  }
  return (
    <div className="flex items-center gap-2">
      <span className={clsx("size-2 rounded-full shrink-0", encoder?.online ? "bg-emerald-500" : "bg-red-500")}
        title={encoder?.online ? t("encoder.online") : t("encoder.offline")} />
      <Select aria-label={t("encoder.label")} value={encoderId ?? ""} onChange={(e) => setEncoderId(e.target.value || null)}
        className={clsx("h-8 text-[13px]", compact ? "w-44" : "w-full")}>
        <option value="">{t("encoder.select")}</option>
        {encoders.map((e) => (
          <option key={e.id} value={e.id}>{e.name}{e.online ? "" : ` (${t("encoder.offline")})`}{e.mock ? ` · ${t("encoder.mock")}` : ""}</option>
        ))}
      </Select>
    </div>
  );
}

// ------------------------------------------------------------------------------------- the card step
type Phase = "idle" | "running" | "done" | "error";

export function CardStep<T>({ op, run, onDone, instruction, actionLabel, doneLabel, successContent, disabled, disabledReason }: {
  op: string;
  run: () => Promise<T>;
  onDone?: (result: T) => void;
  instruction?: ReactNode;
  actionLabel?: string;
  doneLabel?: ReactNode;
  successContent?: (result: T) => ReactNode;
  disabled?: boolean;
  disabledReason?: ReactNode;
}) {
  const { encoder, meta } = useApp();
  const { t, tr, errorText } = useI18n();
  const { ready, reason } = useEncoderReady(op);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const isSuper = meta?.me.permissions.includes("calibration");
  const encoderName = <b>{encoder?.name ?? t("encoder.theEncoder")}</b>;

  const go = async () => {
    setPhase("running");
    setError(null);
    try {
      const r = await run();
      setResult(r);
      setPhase("done");
      onDone?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, { message: String(e) }));
      setPhase("error");
    }
  };

  const blocker = !ready && (
    reason === "no_encoder" ? (
      <Notice tone="amber" icon={<Usb className="size-4" />}>
        {t("cardStep.chooseEncoder")}
        <div className="mt-2"><EncoderPicker /></div>
      </Notice>
    ) : reason === "offline" ? (
      <Notice tone="red" icon={<WifiOff className="size-4" />}>{tr("cardStep.offline", { encoder: encoderName })}</Notice>
    ) : reason === "disabled" ? (
      <Notice tone="red" icon={<WifiOff className="size-4" />}>{tr("cardStep.disabled", { encoder: encoderName })}</Notice>
    ) : (
      <Notice tone="amber" icon={<Wrench className="size-4" />}>
        {t("cardStep.uncalibrated")}{" "}
        {isSuper ? <Link to="/settings/calibration" className="underline font-medium">{t("cardStep.openCalibration")}</Link>
          : t("cardStep.askSuper")}
      </Notice>
    )
  );

  return (
    <div className={clsx("rounded-xl border p-4 transition-colors",
      phase === "done" ? "border-emerald-500/40 bg-emerald-500/5" :
      phase === "error" ? "border-red-500/40 bg-red-500/5" : "border-line bg-surface-2/60")}>
      <div className="flex items-start gap-3">
        <div className={clsx("rounded-lg p-2 shrink-0",
          phase === "done" ? "bg-emerald-500/15 text-emerald-600" :
          phase === "error" ? "bg-red-500/15 text-red-600" : "bg-primary-soft text-primary")}>
          {phase === "running" ? <Loader2 className="size-5 animate-spin" /> :
            phase === "done" ? <CheckCircle2 className="size-5" /> :
            phase === "error" ? <AlertTriangle className="size-5" /> : <CreditCard className="size-5" />}
        </div>
        <div className="flex-1 min-w-0">
          {phase === "idle" && (
            <>
              <div className="text-sm font-medium">{instruction ?? tr("cardStep.placeBlank", { encoder: encoderName })}</div>
              <div className="text-xs text-muted mt-0.5">{t("cardStep.keepOnEncoder")}</div>
            </>
          )}
          {phase === "running" && (
            <>
              <div className="text-sm font-medium">{t("cardStep.writing")}</div>
              <div className="text-xs text-muted mt-0.5">{t("cardStep.dontRemove")}</div>
            </>
          )}
          {phase === "done" && (
            <>
              <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{doneLabel ?? t("cardStep.written")}</div>
              {result !== null && successContent?.(result as T)}
            </>
          )}
          {phase === "error" && error && (
            <>
              <div className="text-sm font-medium text-red-700 dark:text-red-300">{t(`cardStep.errorTitle.${errorTitleKey(error)}`)}</div>
              <div className="text-xs text-muted mt-0.5">{errorText(error)}</div>
            </>
          )}
        </div>
      </div>
      {phase !== "done" && (
        <div className="mt-3 space-y-3">
          {blocker}
          {disabled && disabledReason && <div className="text-xs text-muted">{disabledReason}</div>}
          <div className="flex justify-end">
            <Button variant="primary" onClick={go} loading={phase === "running"} disabled={!ready || disabled}
              icon={phase === "error" ? <RotateCcw className="size-4" /> : <CreditCard className="size-4" />}>
              {phase === "error" ? t("common.tryAgain") : actionLabel ?? t("cardStep.writeCard")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const TITLED = ["encoder_error", "encoder_offline", "encoder_timeout", "template_not_calibrated", "room_occupied",
  "room_reserved", "max_cards", "wrong_card"];
function errorTitleKey(e: ApiError) {
  return TITLED.includes(e.code) ? e.code : "generic";
}

// ------------------------------------------------------------------------------------- room status
export const STATUS_STYLE: Record<RoomStatus, { bg: string; text: string; ring: string; dot: string }> = {
  VC: { bg: "bg-st-vc", text: "text-st-vc", ring: "ring-st-vc/40", dot: "bg-st-vc" },
  VD: { bg: "bg-st-vd", text: "text-st-vd", ring: "ring-st-vd/40", dot: "bg-st-vd" },
  OC: { bg: "bg-st-oc", text: "text-st-oc", ring: "ring-st-oc/40", dot: "bg-st-oc" },
  TM: { bg: "bg-st-tm", text: "text-st-tm", ring: "ring-st-tm/40", dot: "bg-st-tm" },
  OH: { bg: "bg-st-oh", text: "text-st-oh", ring: "ring-st-oh/40", dot: "bg-st-oh" },
  OT: { bg: "bg-st-ot", text: "text-st-ot", ring: "ring-st-ot/40", dot: "bg-st-ot" },
  TO: { bg: "bg-st-to", text: "text-st-to", ring: "ring-st-to/40", dot: "bg-st-to" },
  OO: { bg: "bg-st-oo", text: "text-st-oo", ring: "ring-st-oo/40", dot: "bg-st-oo" },
};

export function StatusBadge({ status }: { status: RoomStatus }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-medium">
      <span className={clsx("size-2 rounded-full", STATUS_STYLE[status].dot)} />
      {t(`status.${status}`)}
    </span>
  );
}
