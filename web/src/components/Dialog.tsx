import clsx from "clsx";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { Button, IconButton } from "./ui";

// Open dialogs/drawers, innermost last: only the top one reacts to Esc and Tab.
const stack: symbol[] = [];

function useLockedFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = Symbol("dialog");
    stack.push(id);
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])
        .filter((n) => !n.hasAttribute("disabled"));
    const first = focusables().find((n) => n.dataset.autofocus !== undefined) ?? focusables().find((n) => n.tagName !== "BUTTON") ?? focusables()[0];
    setTimeout(() => first?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(id), 1);
      if (!stack.length) document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function Dialog({ open, onClose, title, description, children, footer, size = "md", icon }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode;
  footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl"; icon?: ReactNode;
}) {
  const ref = useLockedFocus(open, onClose);
  const t = useT();
  if (!open) return null;
  const width = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true"
        className={clsx("relative flex max-h-[92vh] w-full flex-col rounded-t-2xl sm:rounded-2xl bg-surface shadow-2xl border border-line", width)}>
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          {icon && <div className="rounded-lg bg-primary-soft p-2 text-primary">{icon}</div>}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          <IconButton label={t("common.close")} onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3 bg-surface-2/50 rounded-b-2xl">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = "max-w-lg" }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string;
}) {
  const ref = useLockedFocus(open, onClose);
  const t = useT();
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true"
        className={clsx("relative flex h-full w-full flex-col bg-surface shadow-2xl border-s border-line", width)}>
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="flex-1 min-w-0">{typeof title === "string" ? <h2 className="text-lg font-semibold">{title}</h2> : title}
            {subtitle && <div className="mt-1 text-[13px] text-muted">{subtitle}</div>}</div>
          <IconButton label={t("common.close")} onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------------------- confirm()
interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const t = useT();
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={!!state} onClose={() => close(false)} title={state?.title} size="sm"
        footer={<>
          <Button onClick={() => close(false)}>{t("common.cancel")}</Button>
          <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)} data-autofocus>
            {state?.confirmLabel ?? t("common.confirm")}
          </Button>
        </>}>
        {state?.message && <div className="text-sm text-muted">{state.message}</div>}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
