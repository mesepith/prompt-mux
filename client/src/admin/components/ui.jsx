import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, X } from 'lucide-react';
import clsx from 'clsx';

/**
 * Small presentational primitives shared by every admin panel, so the dashboard
 * stays visually consistent with the chat app (Tailwind only, surface-* palette,
 * no per-component CSS files).
 */

// ---------- layout ----------

export function Card({ title, description, actions, children, className }) {
  return (
    <section
      className={clsx(
        'rounded-2xl border border-white/[0.07] bg-surface-900/60 backdrop-blur',
        className
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>}
            {description && <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, hint, tone = 'default', icon: Icon }) {
  const tones = {
    default: 'text-zinc-100',
    good: 'text-emerald-400',
    warn: 'text-amber-400',
    bad: 'text-rose-400',
  };
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {Icon && <Icon size={12} />}
        {label}
      </div>
      <div className={clsx('mt-1.5 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}

/** Horizontally scrollable table wrapper — the tables are wide on purpose. */
export function TableWrap({ children }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export function Th({ children, className, align = 'left' }) {
  return (
    <th
      className={clsx(
        'whitespace-nowrap border-b border-white/[0.06] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, align = 'left' }) {
  return (
    <td
      className={clsx(
        'border-b border-white/[0.04] px-4 py-3 text-sm text-zinc-300',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className
      )}
    >
      {children}
    </td>
  );
}

export function EmptyRow({ colSpan, children }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-zinc-500">
        {children}
      </td>
    </tr>
  );
}

// ---------- controls ----------

const BUTTON_VARIANTS = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 disabled:hover:bg-indigo-600 border-transparent',
  secondary:
    'bg-white/[0.05] text-zinc-200 hover:bg-white/[0.09] border-white/[0.08]',
  ghost: 'bg-transparent text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 border-transparent',
  danger: 'bg-rose-600/90 text-white hover:bg-rose-600 border-transparent',
  success: 'bg-emerald-600/90 text-white hover:bg-emerald-600 border-transparent',
};

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  disabled,
  busy,
  icon: Icon,
  title,
  className,
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-[13px]',
        BUTTON_VARIANTS[variant],
        className
      )}
    >
      {busy ? <Loader2 size={size === 'sm' ? 12 : 14} className="animate-spin" /> : Icon && <Icon size={size === 'sm' ? 12 : 14} />}
      {children}
    </button>
  );
}

export function IconButton({ onClick, icon: Icon, title, tone = 'ghost', busy, disabled }) {
  const tones = {
    ghost: 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200',
    danger: 'text-rose-400/80 hover:bg-rose-500/10 hover:text-rose-300',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled || busy}
      className={clsx('rounded-lg p-2 transition-colors disabled:opacity-40', tones[tone])}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
    </button>
  );
}

export function Field({ label, hint, error, children, className, required }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1.5 flex items-center gap-1 text-xs font-medium text-zinc-400">
        {label}
        {required && <span className="text-rose-400">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-[11px] leading-4 text-zinc-500">{hint}</span>}
      {error && <span className="mt-1 block text-[11px] leading-4 text-rose-400">{error}</span>}
    </label>
  );
}

const INPUT_CLASS =
  'w-full rounded-lg border border-white/[0.08] bg-surface-950/80 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-indigo-500/60 disabled:opacity-50';

export function TextInput({ value, onChange, placeholder, type = 'text', disabled, mono, autoFocus, onKeyDown, name }) {
  return (
    <input
      name={name}
      type={type}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      className={clsx(INPUT_CLASS, mono && 'font-mono text-[13px]')}
    />
  );
}

/**
 * Number field that keeps the raw string while typing (so "0." and "" are
 * possible) and reports null for empty — a price of "unknown" is not zero.
 */
export function NumberInput({ value, onChange, placeholder, step = 'any', min = 0, disabled }) {
  const [draft, setDraft] = useState(value ?? value === 0 ? String(value) : '');
  const lastExternal = useRef(value);

  useEffect(() => {
    if (lastExternal.current !== value) {
      lastExternal.current = value;
      setDraft(value === null || value === undefined ? '' : String(value));
    }
  }, [value]);

  return (
    <input
      type="number"
      step={step}
      min={min}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw.trim() === '') {
          lastExternal.current = null;
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        if (!Number.isNaN(parsed)) {
          lastExternal.current = parsed;
          onChange(parsed);
        }
      }}
      className={clsx(INPUT_CLASS, 'tabular-nums')}
    />
  );
}

export function TextArea({ value, onChange, placeholder, rows = 3, disabled }) {
  return (
    <textarea
      rows={rows}
      value={value ?? ''}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(INPUT_CLASS, 'resize-y')}
    />
  );
}

export function Select({ value, onChange, options, disabled, placeholder }) {
  return (
    <div className="relative">
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(INPUT_CLASS, 'appearance-none pr-9')}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500"
      />
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, busy, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-emerald-600' : 'bg-zinc-700'
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]'
        )}
      />
      {busy && (
        <Loader2 size={10} className="absolute -right-4 animate-spin text-zinc-500" />
      )}
    </button>
  );
}

export function Checkbox({ checked, onChange, label, disabled }) {
  return (
    <label className={clsx('flex cursor-pointer items-center gap-2 text-sm text-zinc-300', disabled && 'opacity-50')}>
      <span
        className={clsx(
          'grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors',
          checked ? 'border-indigo-500 bg-indigo-600' : 'border-white/15 bg-transparent'
        )}
      >
        {checked && <Check size={11} className="text-white" />}
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

// ---------- feedback ----------

const BADGE_TONES = {
  neutral: 'border-white/10 bg-white/[0.04] text-zinc-400',
  good: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  bad: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
  info: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
  accent: 'border-indigo-500/25 bg-indigo-500/10 text-indigo-300',
};

export function Badge({ children, tone = 'neutral', icon: Icon, title, className }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        BADGE_TONES[tone],
        className
      )}
    >
      {Icon && <Icon size={10} />}
      {children}
    </span>
  );
}

export function Callout({ tone = 'info', children, icon: Icon = AlertTriangle }) {
  const tones = {
    info: 'border-sky-500/20 bg-sky-500/[0.07] text-sky-200',
    warn: 'border-amber-500/20 bg-amber-500/[0.07] text-amber-200',
    bad: 'border-rose-500/20 bg-rose-500/[0.07] text-rose-200',
  };
  return (
    <div className={clsx('flex gap-2.5 rounded-xl border px-4 py-3 text-xs leading-5', tones[tone])}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
      <Loader2 size={15} className="animate-spin" />
      {label}
    </div>
  );
}

/** Toast, wired to the store's `toast` / `dismissToast`. Auto-hides. */
export function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onDismiss, toast.kind === 'error' ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2">
      <div
        className={clsx(
          'pointer-events-auto flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-2xl shadow-black/60 animate-fade-in',
          toast.kind === 'error'
            ? 'border-rose-500/30 bg-rose-950/90 text-rose-100'
            : 'border-emerald-500/30 bg-emerald-950/90 text-emerald-100'
        )}
      >
        <span className="min-w-0 flex-1 break-words">{toast.message}</span>
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------- overlays ----------

/** Centred modal. Escape and backdrop clicks close it. */
export function Modal({ title, description, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8">
      <div
        className="absolute inset-0"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <div
        className={clsx(
          'relative my-auto w-full rounded-2xl border border-white/10 bg-surface-850 shadow-2xl shadow-black/70 animate-fade-in',
          wide ? 'max-w-4xl' : 'max-w-xl'
        )}
      >
        <header className="flex items-start gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
            {description && <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>}
          </div>
          <IconButton icon={X} title="Close" onClick={onClose} />
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * Inline confirm for destructive rows: renders `children` (the trigger) until
 * clicked, then a "Sure? Yes / No" pair. Cheaper than a modal per row and
 * impossible to mis-fire.
 */
export function ConfirmInline({ onConfirm, label = 'Delete', busy, tone = 'danger', children }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return <span onClick={() => setArmed(true)}>{children}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant={tone} busy={busy} onClick={() => onConfirm().finally?.(() => setArmed(false))}>
        {label}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** Monospace value with a copy button — used for API model ids and slugs. */
export function Mono({ children, className }) {
  return (
    <code className={clsx('rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-zinc-300', className)}>
      {children}
    </code>
  );
}
