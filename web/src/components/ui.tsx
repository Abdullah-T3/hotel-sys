import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

// ------------------------------------------------------------------------------------- button
type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
const variants: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover shadow-sm dark:text-gray-950",
  secondary: "bg-surface text-fg border border-line hover:bg-surface-2 shadow-xs",
  ghost: "text-fg hover:bg-surface-2",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
  success: "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm",
};
const sizes = { sm: "h-8 px-2.5 text-[13px] gap-1.5", md: "h-9 px-3.5 text-sm gap-2", lg: "h-11 px-5 text-[15px] gap-2" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof sizes;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading}
      className={clsx("inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg",
        "disabled:opacity-50 disabled:pointer-events-none", variants[variant], sizes[size], className)} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label}
      className={clsx("inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...rest} />
  );
}

// ------------------------------------------------------------------------------------- form
const control = "w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-muted/70 " +
  "focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary disabled:opacity-60 disabled:bg-surface-2";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest }, ref) {
  return <input ref={ref} className={clsx(control, "h-9", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest }, ref) {
  return <select ref={ref} className={clsx(control, "h-9 pe-8", className)} {...rest}>{children}</select>;
});

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(control, "py-2 min-h-[72px]", className)} {...rest} />;
}

export function Field({ label, hint, error, required, children, className, group }: {
  label: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; className?: string;
  /** Render as a group (for button groups / pickers) instead of a <label> wrapping one input. */
  group?: boolean;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag role={group ? "group" : undefined} className={clsx("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium text-fg">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
      {error ? <span className="text-xs text-red-600">{error}</span> : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </Tag>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={id} className="flex-1 cursor-pointer">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-xs text-muted mt-0.5">{description}</div>}
      </label>
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx("relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          checked ? "bg-primary" : "bg-line")}>
        <span className={clsx("absolute start-0 top-0.5 size-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4.5 rtl:-translate-x-4.5" : "translate-x-0.5 rtl:-translate-x-0.5")} />
      </button>
    </div>
  );
}

export function Checkbox({ checked, onChange, label, className }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; className?: string;
}) {
  return (
    <label className={clsx("inline-flex items-center gap-2 text-sm cursor-pointer select-none", className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-line accent-[var(--primary)]" />
      {label}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string;
}) {
  return (
    <div role="radiogroup" className={clsx("inline-flex rounded-lg bg-surface-2 p-0.5 border border-line", className)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={clsx("px-3 h-8 rounded-md text-[13px] font-medium transition-colors",
            value === o.value ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------- display
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("rounded-xl border border-line bg-surface shadow-xs", className)} {...rest}>{children}</div>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="text-[13px] text-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  gray: "bg-surface-2 text-muted border-line",
  green: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-300",
  blue: "bg-blue-500/10 text-blue-700 border-blue-500/20 dark:text-blue-300",
  amber: "bg-amber-500/10 text-amber-700 border-amber-500/25 dark:text-amber-300",
  red: "bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-300",
  violet: "bg-violet-500/10 text-violet-700 border-violet-500/20 dark:text-violet-300",
};
export type Tone = keyof typeof tones;

export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
      tones[tone], className)}>{children}</span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("size-5 animate-spin text-muted", className)} />;
}

export function Empty({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {icon && <div className="mb-3 rounded-full bg-surface-2 p-3 text-muted">{icon}</div>}
      <div className="font-medium">{title}</div>
      {description && <div className="mt-1 max-w-sm text-sm text-muted">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; icon?: ReactNode; hidden?: boolean }[];
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line overflow-x-auto">
      {tabs.filter((t) => !t.hidden).map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} type="button" onClick={() => onChange(t.value)}
          className={clsx("flex items-center gap-2 px-3 h-10 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
            value === t.value ? "border-primary text-fg" : "border-transparent text-muted hover:text-fg")}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Kv({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted shrink-0">{label}</span>
      <span className="text-end font-medium min-w-0 truncate">{children}</span>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Notice({ tone = "amber", icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed", tones[tone], className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
