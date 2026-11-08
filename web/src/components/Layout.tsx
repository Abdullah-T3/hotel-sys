import clsx from "clsx";
import { BarChart3, BedDouble, Building2, CalendarRange, ChevronDown, CreditCard, KeyRound, LayoutGrid, LogOut,
  Menu, Monitor, Moon, ScanLine, Settings, ShieldCheck, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useT } from "../i18n";
import { useApp } from "../lib/app";
import { fmtClock } from "../lib/format";
import { AccountDialog } from "./AccountDialog";
import { CardInfoDialog } from "./CardInfo";
import { EncoderPicker } from "./CardWriter";
import { LanguageMenu } from "./LanguageSwitcher";
import { Button, IconButton } from "./ui";

interface NavItem { to: string; label: string; icon: ReactNode; perm: string | string[] }

const NAV: NavItem[] = [
  { to: "/", label: "nav.reception", icon: <LayoutGrid className="size-4" />, perm: "reception" },
  { to: "/groups", label: "nav.groups", icon: <CalendarRange className="size-4" />, perm: "reception" },
  { to: "/rooms", label: "nav.rooms", icon: <Building2 className="size-4" />, perm: "rooms_manage" },
  { to: "/staff-cards", label: "nav.staffCards", icon: <CreditCard className="size-4" />, perm: "staff_cards" },
  { to: "/lock-setup", label: "nav.lockSetup", icon: <KeyRound className="size-4" />, perm: "lock_setup" },
  { to: "/reports", label: "nav.reports", icon: <BarChart3 className="size-4" />, perm: "reports_view" },
  { to: "/settings", label: "nav.settings", icon: <Settings className="size-4" />,
    perm: ["settings", "operators", "encoders", "audit", "calibration"] },
];

function allowed(can: (p: string) => boolean, perm: string | string[]) {
  return Array.isArray(perm) ? perm.some(can) : can(perm);
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { meta, can } = useApp();
  const t = useT();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line">
        <div className="rounded-lg bg-primary p-1.5 text-white dark:text-gray-950"><BedDouble className="size-4" /></div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{meta?.hotel_name ?? t("app.hotel")}</div>
          <div className="text-[11px] text-muted">{t("app.name")}</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {NAV.filter((n) => allowed(can, n.perm)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} onClick={onNavigate}
            className={({ isActive }) => clsx("flex items-center gap-2.5 rounded-lg px-3 h-9 text-sm font-medium transition-colors",
              isActive ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-fg")}>
            {n.icon}
            {t(n.label)}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-line text-[11px] text-muted flex items-center gap-1.5">
        <ShieldCheck className="size-3.5" /> {meta && t(`role.${meta.me.role}`)}
      </div>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return <span className="hidden lg:inline text-[13px] text-muted tabular-nums">{fmtClock(now)}</span>;
}

function ThemeToggle() {
  const { theme, setTheme } = useApp();
  const t = useT();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return <IconButton label={t("theme.switch", { current: t(`theme.${theme}`), next: t(`theme.${next}`) })}
    onClick={() => setTheme(next)}><Icon className="size-4" /></IconButton>;
}

function UserMenu() {
  const { meta, signOut } = useApp();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);
  const op = meta?.me.operator;
  const initials = (op?.name ?? "?").split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-1.5 h-9 hover:bg-surface-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary-soft text-primary text-xs font-semibold">{initials}</span>
        <span className="hidden md:block text-sm font-medium max-w-32 truncate">{op?.name ?? t("audit.apiKey")}</span>
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="absolute end-0 mt-1 w-60 rounded-xl border border-line bg-surface p-1 shadow-xl z-30">
          <div className="px-3 py-2 border-b border-line mb-1">
            <div className="text-sm font-medium truncate">{op?.name}</div>
            <div className="text-xs text-muted">{op?.username} · {meta && t(`role.${meta.me.role}`)}</div>
          </div>
          <LanguageMenu onPicked={() => setOpen(false)} />
          <div className="border-t border-line my-1" />
          {op && (
            <button type="button" onClick={() => { setOpen(false); setAccount(true); }}
              className="flex w-full items-center gap-2 rounded-lg px-3 h-9 text-sm hover:bg-surface-2">
              <KeyRound className="size-4 text-muted" /> {t("account.changePassword")}
            </button>
          )}
          <button type="button" onClick={() => signOut()}
            className="flex w-full items-center gap-2 rounded-lg px-3 h-9 text-sm text-red-600 hover:bg-red-500/10">
            <LogOut className="size-4 rtl:-scale-x-100" /> {t("account.signOut")}
          </button>
        </div>
      )}
      <AccountDialog open={account} onClose={() => setAccount(false)} />
    </div>
  );
}

export function Layout() {
  const { can } = useApp();
  const t = useT();
  const [mobileNav, setMobileNav] = useState(false);
  const [cardInfo, setCardInfo] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileNav(false), [loc.pathname]);

  return (
    <div className="flex h-full">
      <aside className="no-print hidden lg:block w-60 shrink-0 border-e border-line bg-surface"><Sidebar /></aside>
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNav(false)} />
          <aside className="relative h-full w-64 bg-surface shadow-xl">
            <IconButton label={t("nav.closeMenu")} className="absolute end-2 top-3" onClick={() => setMobileNav(false)}><X className="size-4" /></IconButton>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 backdrop-blur px-3 sm:px-5">
          <IconButton label={t("nav.menu")} className="lg:hidden" onClick={() => setMobileNav(true)}><Menu className="size-5" /></IconButton>
          <div className="flex-1" />
          <Clock />
          <EncoderPicker compact />
          {can("reception") && (
            <Button size="sm" variant="secondary" icon={<ScanLine className="size-4" />} onClick={() => setCardInfo(true)}
              aria-label={t("cardInfo.readCard")}>
              <span className="hidden sm:inline">{t("cardInfo.readCard")}</span>
            </Button>
          )}
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="flex-1 overflow-y-auto p-3 sm:p-6"><Outlet /></main>
      </div>
      <CardInfoDialog open={cardInfo} onClose={() => setCardInfo(false)} />
    </div>
  );
}
