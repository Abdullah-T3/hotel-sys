/**
 * Tiny i18n layer: flat dictionaries, {param} interpolation, CLDR plurals
 * (key_one / key_few / key_many / key_other …), rich-text placeholders and RTL.
 * English is the source of truth; any missing key falls back to English.
 */
import type { Locale } from "date-fns";
import { ar, enGB, ru, tr, vi, zhCN } from "date-fns/locale";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { fmtDateTime, setFormatContext } from "../lib/format";
import arDict from "./ar";
import en from "./en";
import ruDict from "./ru";
import trDict from "./tr";
import viDict from "./vi";
import zhDict from "./zh";

export const LANGUAGES = [
  { code: "en", name: "English", dir: "ltr", locale: enGB, intl: "en-GB" },
  { code: "ar", name: "العربية", dir: "rtl", locale: ar, intl: "ar-u-nu-latn" },
  { code: "zh", name: "简体中文", dir: "ltr", locale: zhCN, intl: "zh-CN" },
  { code: "ru", name: "Русский", dir: "ltr", locale: ru, intl: "ru-RU" },
  { code: "tr", name: "Türkçe", dir: "ltr", locale: tr, intl: "tr-TR" },
  { code: "vi", name: "Tiếng Việt", dir: "ltr", locale: vi, intl: "vi-VN" },
] as const satisfies readonly { code: string; name: string; dir: "ltr" | "rtl"; locale: Locale; intl: string }[];

export type Lang = (typeof LANGUAGES)[number]["code"];
export type Key = keyof typeof en;
type Dict = Partial<Record<string, string>>;
type Params = Record<string, string | number | null | undefined>;

const DICTS: Record<Lang, Dict> = { en, ar: arDict, zh: zhDict, ru: ruDict, tr: trDict, vi: viDict };
const STORAGE_KEY = "d801.lang";

export function isLang(v: unknown): v is Lang {
  return LANGUAGES.some((l) => l.code === v);
}

function detect(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLang(stored)) return stored;
  const nav = navigator.language?.slice(0, 2);
  return isLang(nav) ? nav : "en";
}

function makeT(lang: Lang) {
  const dict = DICTS[lang];
  const enDict = en as Dict;
  const rules = new Intl.PluralRules(LANGUAGES.find((l) => l.code === lang)!.intl);
  const enRules = new Intl.PluralRules("en");
  const pick = (key: string, params?: Params) => {
    const count = params?.count;
    if (typeof count === "number") {
      const cat = rules.select(count);
      const own = dict[`${key}_${cat}`] ?? dict[`${key}_other`];
      if (own !== undefined) return own;
      const enCat = enRules.select(count);
      const fb = enDict[`${key}_${enCat}`] ?? enDict[`${key}_other`];
      if (fb !== undefined) return fb;
    }
    return dict[key] ?? enDict[key] ?? enDict[`${key}_other`] ?? key;
  };
  const t = (key: Key | string, params?: Params): string =>
    pick(key, params).replace(/\{(\w+)\}/g, (m, p) => (params && params[p] !== undefined && params[p] !== null ? String(params[p]) : m));
  /** Like t(), but placeholders may be React nodes (e.g. <b>{name}</b>). */
  const tr = (key: Key | string, params: Record<string, ReactNode>): ReactNode => {
    const parts = pick(key, params as Params).split(/(\{\w+\})/g);
    return parts.map((part, i) => {
      const m = part.match(/^\{(\w+)\}$/);
      return <Fragment key={i}>{m && m[1] in params ? params[m[1]] : part}</Fragment>;
    });
  };
  return { t, tr };
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  dir: "ltr" | "rtl";
  locale: Locale;
  intl: string;
  t: ReturnType<typeof makeT>["t"];
  tr: ReturnType<typeof makeT>["tr"];
  /** Translate an API error via its code + structured fields; falls back to the server's English message. */
  errorText: (e: unknown) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect);
  const meta = LANGUAGES.find((l) => l.code === lang)!;
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.dir;
  }, [lang, meta.dir]);
  const setLang = useCallback((l: Lang) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  }, []);
  const value = useMemo<I18n>(() => {
    const { t, tr } = makeT(lang);
    setFormatContext({ locale: meta.locale, intl: meta.intl, t });
    const errorText = (e: unknown) => {
      if (!(e instanceof ApiError)) return String(e instanceof Error ? e.message : e);
      const key = `error.${e.code}`;
      if (!(key in en) && DICTS[lang][key] === undefined) return e.message;
      const b = e.body as Record<string, unknown>;
      const params: Params = {};
      for (const [k, v] of Object.entries(b)) if (typeof v === "string" || typeof v === "number") params[k] = v;
      if (typeof b.op === "string") params.op = t(`op.${b.op}`);
      for (const k of ["check_in", "check_out"]) if (typeof b[k] === "string") params[k] = fmtDateTime(b[k] as string);
      return t(key, params);
    };
    return { lang, setLang, dir: meta.dir, locale: meta.locale, intl: meta.intl, t, tr, errorText };
  }, [lang, meta, setLang]);
  // Remount the tree on language change so every label and date re-renders in the new language.
  return <Ctx.Provider value={value}><Fragment key={lang}>{children}</Fragment></Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}

/** Shorthand used by almost every component. */
export function useT() {
  return useI18n().t;
}
