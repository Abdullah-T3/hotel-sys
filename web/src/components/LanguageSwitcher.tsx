import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Languages } from "lucide-react";
import { isLang, LANGUAGES, useI18n, type Lang } from "../i18n";
import { api, tokenStore, type Meta } from "../lib/api";
import { Select } from "./ui";

/** Change the UI language; when signed in, remember it on the operator's account too. */
export function useChangeLanguage() {
  const { setLang } = useI18n();
  const qc = useQueryClient();
  return (l: Lang) => {
    if (tokenStore.get()) {
      api.put("/v1/auth/preferences", { language: l }).catch(() => {});
      // Keep the cached account info in step, so nothing switches the language back.
      qc.setQueryData<Meta>(["meta"], (m) => (m?.me.operator
        ? { ...m, me: { ...m.me, operator: { ...m.me.operator, language: l } } } : m));
    }
    setLang(l);
  };
}

export function LanguageSelect({ className }: { className?: string }) {
  const { lang, t } = useI18n();
  const change = useChangeLanguage();
  return (
    <label className={clsx("relative inline-flex items-center", className)}>
      <Languages className="pointer-events-none absolute start-2.5 size-4 text-muted" />
      <Select aria-label={t("language.label")} value={lang} onChange={(e) => isLang(e.target.value) && change(e.target.value)}
        className="h-8 ps-8 text-[13px]">
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </Select>
    </label>
  );
}

export function LanguageMenu({ onPicked }: { onPicked?: () => void }) {
  const { lang, t } = useI18n();
  const change = useChangeLanguage();
  return (
    <div className="py-1">
      <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted flex items-center gap-1.5">
        <Languages className="size-3.5" />{t("language.label")}
      </div>
      {LANGUAGES.map((l) => (
        <button key={l.code} type="button" lang={l.code} dir={l.dir}
          onClick={() => { onPicked?.(); change(l.code); }}
          className="flex w-full items-center gap-2 rounded-lg px-3 h-8 text-sm hover:bg-surface-2">
          <span className="flex-1 text-start">{l.name}</span>
          {lang === l.code && <Check className="size-4 text-primary" />}
        </button>
      ))}
    </div>
  );
}
