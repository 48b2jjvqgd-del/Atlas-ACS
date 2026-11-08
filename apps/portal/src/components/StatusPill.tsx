type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

const tones: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok ring-ok/30',
  warn: 'bg-warn-soft text-warn ring-warn/30',
  danger: 'bg-danger-soft text-danger ring-danger/30',
  neutral: 'bg-surface-raised text-ink-muted ring-line-strong',
  accent: 'bg-accent-soft text-accent-strong ring-accent/30',
};

export function StatusPill({
  tone,
  children,
  dot = true,
}: {
  tone: Tone;
  children: string;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
