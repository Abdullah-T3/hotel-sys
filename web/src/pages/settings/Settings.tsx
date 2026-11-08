import { History, Hotel, Usb, UserCog, Wrench } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { PageHeader, Tabs } from "../../components/ui";
import { useT } from "../../i18n";
import { useApp } from "../../lib/app";
import Audit from "./Audit";
import Calibration from "./Calibration";
import Encoders from "./Encoders";
import General from "./General";
import Operators from "./Operators";

type Tab = "general" | "operators" | "encoders" | "calibration" | "audit";

export default function SettingsPage() {
  const { can } = useApp();
  const t = useT();
  const navigate = useNavigate();
  const params = useParams();
  const tabs: { value: Tab; label: string; icon: React.ReactNode; hidden: boolean }[] = [
    { value: "general", label: t("settings.tab.general"), icon: <Hotel className="size-4" />, hidden: !can("settings") },
    { value: "operators", label: t("settings.tab.operators"), icon: <UserCog className="size-4" />, hidden: !can("operators") },
    { value: "encoders", label: t("settings.tab.encoders"), icon: <Usb className="size-4" />, hidden: !can("encoders") },
    { value: "calibration", label: t("settings.tab.calibration"), icon: <Wrench className="size-4" />, hidden: !can("calibration") },
    { value: "audit", label: t("settings.tab.audit"), icon: <History className="size-4" />, hidden: !can("audit") },
  ];
  const visible = tabs.filter((t) => !t.hidden);
  const tab = (visible.find((t) => t.value === params.tab)?.value ?? visible[0]?.value) as Tab;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t("nav.settings")} description={t("settings.intro")} />
      <div className="mb-5"><Tabs value={tab} onChange={(t) => navigate(`/settings/${t}`)} tabs={tabs} /></div>
      {tab === "general" && <General />}
      {tab === "operators" && <Operators />}
      {tab === "encoders" && <Encoders />}
      {tab === "calibration" && <Calibration />}
      {tab === "audit" && <Audit />}
    </div>
  );
}
