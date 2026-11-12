import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Empty, Spinner } from "./components/ui";
import { isLang, useI18n } from "./i18n";
import { api } from "./lib/api";
import { useApp } from "./lib/app";
import Groups from "./pages/Groups";
import LockSetup from "./pages/LockSetup";
import Login from "./pages/Login";
import Reports from "./pages/Reports";
import Board from "./pages/reception/Board";
import Rooms from "./pages/Rooms";
import SettingsPage from "./pages/settings/Settings";
import Setup from "./pages/Setup";
import StaffCards from "./pages/StaffCards";

// The app remounts on language change, so this lives at module level: an operator's saved language is
// applied once per sign-in - after that, their own choice in the menu wins.
let languageAppliedFor: number | null = null;

function Guard({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useApp();
  const { t } = useI18n();
  const ok = Array.isArray(perm) ? perm.some(can) : can(perm);
  if (!ok) return <Empty icon={<Lock className="size-6" />} title={t("app.notAllowed")} description={t("app.notAllowedText")} />;
  return <>{children}</>;
}

function FullPage({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center">{children}</div>;
}

export default function App() {
  const { token, meta, metaLoading } = useApp();
  const { t, lang, setLang } = useI18n();
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => api.get<{ needs_setup: boolean; hotel_name: string; default_language: string }>("/v1/setup"),
  });

  // A browser that never picked a language starts in the hotel's default language.
  useEffect(() => {
    const def = setup.data?.default_language;
    if (!localStorage.getItem("d801.lang") && isLang(def) && def !== lang) setLang(def);
  }, [setup.data, lang, setLang]);
  // After sign-in, use the operator's own saved language (once).
  useEffect(() => {
    const op = meta?.me.operator;
    if (!op || languageAppliedFor === op.id) return;
    languageAppliedFor = op.id;
    if (isLang(op.language) && op.language !== lang) setLang(op.language);
  }, [meta, lang, setLang]);

  if (setup.isLoading) return <FullPage><Spinner className="size-6" /></FullPage>;
  if (setup.isError) return <FullPage><Empty title={t("app.serverUnreachable")} description={String(setup.error)} /></FullPage>;
  if (setup.data?.needs_setup) return <Setup onDone={() => setup.refetch()} />;
  if (!token) return <Login hotelName={setup.data?.hotel_name} />;
  if (metaLoading || !meta) return <FullPage><Spinner className="size-6" /></FullPage>;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Guard perm="reception"><Board /></Guard>} />
        <Route path="groups" element={<Guard perm="reception"><Groups /></Guard>} />
        <Route path="rooms" element={<Guard perm="rooms_manage"><Rooms /></Guard>} />
        <Route path="staff-cards" element={<Guard perm="staff_cards"><StaffCards /></Guard>} />
        <Route path="lock-setup" element={<Guard perm="lock_setup"><LockSetup /></Guard>} />
        <Route path="reports" element={<Guard perm="reports_view"><Reports /></Guard>} />
        <Route path="settings/:tab?" element={<Guard perm={["settings", "operators", "encoders", "audit", "calibration"]}><SettingsPage /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
