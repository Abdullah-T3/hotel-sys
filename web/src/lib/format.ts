import { differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isTomorrow, isYesterday, parseISO, type Locale } from "date-fns";
import { enGB } from "date-fns/locale";

// The active language is pushed here by I18nProvider (the app remounts on language change).
let ctx: { locale: Locale; intl: string; t: (k: string, p?: Record<string, string | number>) => string } = {
  locale: enGB, intl: "en-GB", t: (k) => k,
};
export function setFormatContext(c: typeof ctx) {
  ctx = c;
}

// The API speaks hotel-local wall-clock time as "YYYY-MM-DDTHH:MM".
export function toLocalInput(d: Date) {
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

export function parse(value: string | null | undefined) {
  return value ? parseISO(value) : null;
}

export function fmtDateTime(value: string | null | undefined) {
  const d = parse(value);
  if (!d) return "—";
  const time = format(d, "HH:mm");
  if (isToday(d)) return ctx.t("time.todayAt", { time });
  if (isTomorrow(d)) return ctx.t("time.tomorrowAt", { time });
  if (isYesterday(d)) return ctx.t("time.yesterdayAt", { time });
  return format(d, "d MMM yyyy, HH:mm", { locale: ctx.locale });
}

export function fmtShort(value: string | null | undefined) {
  const d = parse(value);
  if (!d) return "—";
  if (isToday(d)) return format(d, "HH:mm");
  return format(d, "d MMM HH:mm", { locale: ctx.locale });
}

export function fmtDate(value: string | null | undefined) {
  const d = parse(value);
  return d ? format(d, "d MMM yyyy", { locale: ctx.locale }) : "—";
}

export function fmtClock(d: Date) {
  return format(d, "EEE d MMM · HH:mm", { locale: ctx.locale });
}

export function fromNow(value: string | null | undefined) {
  const d = value ? new Date(value) : null;
  return d ? formatDistanceToNowStrict(d, { addSuffix: true, locale: ctx.locale }) : ctx.t("time.never");
}

export function nights(checkIn: string, checkOut: string) {
  const a = parse(checkIn), b = parse(checkOut);
  return a && b ? Math.max(1, differenceInCalendarDays(b, a)) : 1;
}

export function money(n: number | null | undefined, currency = "") {
  if (n === null || n === undefined) return "—";
  const v = n.toLocaleString(ctx.intl, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency ? `${v} ${currency}` : v;
}

/** Default check-out: N days from today at the hotel's check-out time. */
export function defaultCheckout(nightsCount: number, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + nightsCount);
  d.setHours(h, m, 0, 0);
  return toLocalInput(d);
}

export function cardShort(data: string | null | undefined) {
  if (!data) return "—";
  return data.length > 16 ? `${data.slice(0, 8)}…${data.slice(-6)}` : data;
}

export function actorName(actor: string | null | undefined) {
  if (!actor) return "—";
  if (actor.startsWith("op:")) return actor.slice(3);
  if (actor.startsWith("key:")) return ctx.t("audit.apiKey");
  if (actor.startsWith("agent:")) return ctx.t("audit.agent", { id: actor.slice(6) });
  return actor;
}
