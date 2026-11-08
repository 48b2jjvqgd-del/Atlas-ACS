export function AtlasLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true">
        <rect
          width="32"
          height="32"
          rx="8"
          className="fill-surface-raised stroke-line-strong"
          strokeWidth="1"
        />
        <path d="M16 6 26 25h-4.4L16 14.2 10.4 25H6L16 6Z" className="fill-accent" />
        <path
          d="M11.8 21.2h8.4"
          className="stroke-signal"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-[0.18em] text-ink">ATLAS</span>
          <span className="block text-[11px] tracking-wide text-ink-subtle">
            Access Control Server
          </span>
        </span>
      )}
    </span>
  );
}
