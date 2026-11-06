import { cn } from '@/lib/utils'

// Headings that split the long Overview into parts, and a row of chips that jumps between them.

export function SectionHeading({ id, title, note, first }: { id: string; title: string; note?: string; first?: boolean }) {
  return (
    <div id={id} className={cn('mb-3 flex scroll-mt-4 flex-wrap items-baseline justify-between gap-x-4', first ? 'mt-1' : 'mt-8')}>
      <h2 className="font-display text-[15px] font-bold text-ls-ink">{title}</h2>
      {note && <span className="text-xs text-ls-mute">{note}</span>}
    </div>
  )
}

export const OVERVIEW_SECTIONS = [
  { id: 'sec-measures', label: 'All measures' },
  { id: 'sec-stations', label: 'Stations' },
  { id: 'sec-output', label: 'Output over time' },
  { id: 'sec-utilization', label: 'Utilization' },
  { id: 'sec-time', label: 'Time and delay' },
] as const

export function SectionNav() {
  return (
    <div className="no-print mb-1 mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-ls-mute">Jump to</span>
      {OVERVIEW_SECTIONS.map((s) => (
        <button
          key={s.id}
          onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="h-7 rounded-full bg-ls-card px-3 text-xs font-semibold text-ls-ink2 shadow-sm transition-colors hover:bg-ls-soft"
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}
