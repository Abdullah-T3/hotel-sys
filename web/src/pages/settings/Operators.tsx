import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, UserCog } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, useConfirm } from "../../components/Dialog";
import { Badge, Button, Card, CardHeader, Field, IconButton, Input, Notice, Select, Spinner, Switch } from "../../components/ui";
import { useI18n } from "../../i18n";
import { api, type Operator, type Role } from "../../lib/api";
import { useApp } from "../../lib/app";
import { fromNow } from "../../lib/format";

const RANK: Record<Role, number> = { operator: 0, manager: 1, admin: 2, super: 3 };
const ROLES: Role[] = ["operator", "manager", "admin", "super"];

function OperatorDialog({ op, open, onClose }: { op: Operator | null; open: boolean; onClose: () => void }) {
  const { meta } = useApp();
  const { t, errorText } = useI18n();
  const qc = useQueryClient();
  const myRole = meta!.me.role;
  const [form, setForm] = useState({ username: "", name: "", role: "operator" as Role, password: "", note: "", active: true });
  useEffect(() => {
    if (open) {
      setForm({ username: op?.username ?? "", name: op?.name ?? "", role: op?.role ?? "operator", password: "", note: op?.note ?? "", active: op?.active ?? true });
      save.reset();
    }
  }, [open, op]);  // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => op
      ? api.patch(`/v1/operators/${op.id}`, { name: form.name, note: form.note || null, active: form.active,
          // Only send what changed: a role change (or new password) ends the operator's sessions.
          role: form.role !== op.role ? form.role : undefined, password: form.password || undefined })
      : api.post("/v1/operators", { username: form.username, name: form.name, role: form.role, password: form.password, note: form.note || null }),
    onSuccess: () => { toast.success(op ? t("operators.saved") : t("operators.added")); qc.invalidateQueries({ queryKey: ["operators"] }); onClose(); },
  });
  const roles = ROLES.filter((r) => RANK[r] <= RANK[myRole] && (r !== "super" || myRole === "super"));
  const perms = meta!.role_permissions[form.role];
  return (
    <Dialog open={open} onClose={onClose} title={op ? t("operators.editTitle", { name: op.name }) : t("operators.add")} icon={<UserCog className="size-5" />}
      footer={<><Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!form.name || (!op && (!form.username || form.password.length < 8))}
          onClick={() => save.mutate()}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("login.username")} required><Input dir="ltr" value={form.username} disabled={!!op} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
          <Field label={t("guest.fullName")} required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t("operators.role")}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {roles.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
            </Select>
          </Field>
          <Field label={op ? t("account.newPassword") : t("login.password")} hint={op ? t("operators.keepPassword") : t("account.passwordHint")} required={!op}>
            <Input type="password" dir="ltr" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        <Field label={t("common.note")}><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        {op && <Switch checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label={t("operators.active")} description={t("operators.activeText")} />}
        <div className="rounded-lg bg-surface-2 p-3">
          <div className="text-xs font-medium mb-1.5">{t("operators.roleCan", { role: t(`role.${form.role}`) })}</div>
          <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted list-disc ps-4">
            {perms.map((p) => <li key={p}>{t(`perm.${p}`)}</li>)}
          </ul>
        </div>
        {save.isError && <Notice tone="red">{errorText(save.error)}</Notice>}
      </div>
    </Dialog>
  );
}

export default function Operators() {
  const { meta } = useApp();
  const { t, errorText } = useI18n();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const ops = useQuery({ queryKey: ["operators"], queryFn: () => api.get<Operator[]>("/v1/operators") });
  const [edit, setEdit] = useState<Operator | null | "new">(null);
  const del = async (o: Operator) => {
    if (!(await confirm({ title: t("operators.confirmDelete", { name: o.name }), danger: true, confirmLabel: t("common.delete"), message: t("operators.confirmDeleteText") }))) return;
    try { await api.del(`/v1/operators/${o.id}`); qc.invalidateQueries({ queryKey: ["operators"] }); } catch (e) { toast.error(errorText(e)); }
  };
  return (
    <Card>
      <CardHeader title={t("settings.tab.operators")} description={t("operators.intro")}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>{t("operators.add")}</Button>} />
      {ops.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr className="border-b border-line">
              {[t("common.name"), t("login.username"), t("operators.role"), t("operators.lastSignIn"), ""].map((h, i) =>
                <th key={i} className="px-4 py-2.5 font-medium text-start">{h}</th>)}
            </tr></thead>
            <tbody>{ops.data?.map((o) => {
              const self = o.id === meta?.me.operator?.id;
              const manageable = RANK[o.role] <= RANK[meta!.me.role];
              return (
                <tr key={o.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-medium">{o.name} {self && <Badge tone="blue">{t("operators.you")}</Badge>} {!o.active && <Badge tone="red">{t("operators.inactive")}</Badge>}</td>
                  <td className="px-4 py-2.5 text-muted">{o.username}</td>
                  <td className="px-4 py-2.5"><Badge tone={o.role === "super" ? "violet" : o.role === "admin" ? "blue" : "gray"}>{t(`role.${o.role}`)}</Badge></td>
                  <td className="px-4 py-2.5 text-muted">{o.last_login ? fromNow(o.last_login) : t("time.never")}</td>
                  <td className="px-4 py-2.5 text-end whitespace-nowrap">
                    {manageable && <IconButton label={t("common.edit")} onClick={() => setEdit(o)}><Pencil className="size-4" /></IconButton>}
                    {manageable && !self && <IconButton label={t("common.delete")} onClick={() => del(o)}><Trash2 className="size-4" /></IconButton>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      <OperatorDialog op={edit === "new" ? null : edit} open={edit !== null} onClose={() => setEdit(null)} />
    </Card>
  );
}
