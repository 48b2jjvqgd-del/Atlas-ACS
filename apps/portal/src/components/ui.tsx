import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { describeError } from '../lib/api';
import { Icon } from './Icon';

/* ------------------------------------------------------------------ buttons */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-canvas hover:bg-accent-strong disabled:bg-accent/40',
  secondary:
    'border border-line-strong bg-surface-raised text-ink hover:bg-surface-hover disabled:text-ink-subtle',
  danger: 'bg-danger/90 text-canvas hover:bg-danger disabled:bg-danger/40',
  ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink disabled:text-ink-subtle',
};

export function Button({
  variant = 'secondary',
  busy = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {busy && (
        <span
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ forms */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children(id, hint || error ? hintId : undefined)}
      {(error || hint) && (
        <p id={hintId} className={`text-xs ${error ? 'text-danger' : 'text-ink-subtle'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

const inputClass =
  'block w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none disabled:opacity-60 aria-[invalid=true]:border-danger';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Checkbox({
  label,
  description,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5">
      <input
        type="checkbox"
        {...props}
        className="mt-0.5 size-4 rounded border-line-strong bg-canvas accent-[var(--color-accent)]"
      />
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {description && <span className="block text-xs text-ink-subtle">{description}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ states */

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-6 text-sm text-ink-muted" role="status">
      <span
        className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-9 animate-pulse rounded-lg bg-surface-raised" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">{children}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { title, detail, reference } = describeError(error);
  return (
    <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-5 py-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">{detail}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            <Icon name="refresh" className="size-4" /> Try again
          </Button>
        )}
        {reference && (
          <span className="font-mono text-[11px] text-ink-subtle">Reference {reference}</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tables */

export function Table({ children, minWidth = 640 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`border-b border-line py-3 pr-4 text-xs font-medium uppercase tracking-wider text-ink-subtle ${align === 'right' ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <td className={`border-b border-line/60 py-3 pr-4 align-middle ${className}`}>{children}</td>
  );
}

/* ------------------------------------------------------------------ layout */

export function KeyValues({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs uppercase tracking-wider text-ink-subtle">{item.label}</dt>
          <dd className="mt-1 text-sm text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition-colors ${
            tab.id === active
              ? 'border-accent text-ink'
              : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-4">
      <p className="text-xs uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 bg-canvas/75 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} rounded-xl border border-line-strong bg-surface shadow-2xl`}
      >
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
        </div>
        {children && <div className="space-y-4 px-6 py-5">{children}</div>}
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Confirmation for sensitive operations. Optionally requires a typed confirmation and a reason,
 * which is recorded in the audit trail.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  tone = 'primary',
  requireReason = false,
  typeToConfirm,
  onConfirm,
  onClose,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  requireReason?: boolean;
  typeToConfirm?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready =
    (!requireReason || reason.trim().length >= 3) && (!typeToConfirm || typed === typeToConfirm);
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            busy={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
              } catch (failure) {
                setError(failure);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {requireReason && (
        <Field label="Reason" hint="Recorded in the audit trail.">
          {(id, describedBy) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          )}
        </Field>
      )}
      {typeToConfirm && (
        <Field label={`Type ${typeToConfirm} to confirm`}>
          {(id) => (
            <TextInput
              id={id}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
      )}
      {error !== null && <ErrorState error={error} />}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ toasts */

interface Toast {
  id: number;
  tone: 'success' | 'error';
  message: string;
}

const ToastContext = createContext<(tone: Toast['tone'], message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = next.current++;
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      6_000,
    );
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            data-testid={`toast-${toast.tone}`}
            className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-xl ${
              toast.tone === 'success'
                ? 'border-ok/30 bg-surface-raised text-ink'
                : 'border-danger/40 bg-surface-raised text-ink'
            }`}
          >
            <span
              className={`mr-2 inline-block size-2 rounded-full ${toast.tone === 'success' ? 'bg-ok' : 'bg-danger'}`}
              aria-hidden="true"
            />
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ------------------------------------------------------------------ formatting */

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'Never';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return formatDateTime(value);
}
