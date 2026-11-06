import { Clock, Eye, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ScenarioListItem } from '@/types'
import type { CardStatus, ScenarioSummary } from '@/lib/scenarioSummary'

const BADGE: Record<CardStatus, { label: string; cls: string; dot: string }> = {
  completed: { label: 'Completed', cls: 'bg-ls-ok-t text-ls-ok-i', dot: 'bg-ls-ok' },
  running: { label: 'Running', cls: 'bg-ls-warn-t text-ls-warn-i', dot: 'bg-ls-warn' },
  failed: { label: 'Failed', cls: 'bg-ls-bad-t text-ls-bad-i', dot: 'bg-ls-bad' },
  stopped: { label: 'Stopped', cls: 'bg-ls-warn-t text-ls-warn-i', dot: 'bg-ls-warn' },
  none: { label: 'Never run', cls: 'bg-ls-page text-ls-ink2', dot: 'bg-ls-mute' },
}

export const STATUS_LABEL: Record<CardStatus, string> = {
  completed: 'Completed', running: 'Running', failed: 'Failed', stopped: 'Stopped', none: 'Never run',
}

// The first variant's route as little boxes: one column per step, a split stacks its boxes.
// The newest run's busiest station is outlined.
function Sketch({ columns, bottleneck }: { columns: string[][]; bottleneck: string | null }) {
  const cols = columns.slice(0, 7)
  if (cols.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-ls-mute">No route yet</div>
  }
  const W = 300
  const colW = Math.min(46, (W - 24) / cols.length)
  const gap = cols.length > 1 ? (W - 24 - colW * cols.length) / (cols.length - 1) : 0
  const x0 = (i: number) => 12 + i * (colW + gap)
  const boxH = 20
  const mid = 55
  return (
    <svg viewBox={`0 0 ${W} 110`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
      {cols.slice(1).map((_, i) => (
        <path
          key={`l${i}`}
          d={`M${x0(i) + colW} ${mid}H${x0(i + 1)}`}
          stroke="var(--ls-accent)" strokeWidth="1.8" strokeDasharray="4 4" fill="none"
        />
      ))}
      {cols.map((names, i) => {
        const shown = names.slice(0, 3)
        return shown.map((n, j) => {
          const y = mid - (shown.length * boxH + (shown.length - 1) * 6) / 2 + j * (boxH + 6)
          const hot = bottleneck !== null && n === bottleneck
          return (
            <rect
              key={`${i}-${j}`} x={x0(i)} y={y} width={colW} height={boxH} rx="6"
              fill="var(--ls-card)"
              stroke={hot ? 'var(--ls-bad)' : 'var(--ls-line2)'} strokeWidth={hot ? 2 : 1.4}
            >
              <title>{n}</title>
            </rect>
          )
        })
      })}
    </svg>
  )
}

export default function ScenarioCard({
  scenario, summary, onOpen, onView, onDelete,
}: {
  scenario: ScenarioListItem
  summary: ScenarioSummary | undefined
  onOpen: () => void
  onView: () => void
  onDelete: () => void
}) {
  const badge = summary ? BADGE[summary.status] : null
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  const updated = new Date(scenario.updated_at)

  return (
    <div
      onClick={onOpen}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-[14px] bg-ls-card shadow-md transition-all duration-200 hover:-translate-y-1 hover:shadow-lg"
    >
      <div className="h-1 w-full bg-gradient-to-r from-ls-accent to-ls-purple" />
      <div className="relative h-[110px] bg-ls-canvas">
        {summary ? <Sketch columns={summary.columns} bottleneck={summary.bottleneck} /> : <div className="h-full animate-pulse bg-ls-chip/50" />}
        {badge && (
          <span className={cn('absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold', badge.cls)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', badge.dot)} />
            {badge.label}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <h3 className="truncate font-display text-[15px] font-bold text-ls-ink">{scenario.name}</h3>
        </div>

        {summary?.status === 'running' && (
          <p className="rounded-[10px] bg-ls-soft px-2.5 py-2 text-xs text-ls-ink2">A run is in progress for this scenario.</p>
        )}
        {summary?.status === 'failed' && (
          <p className="rounded-[10px] bg-ls-bad-t px-2.5 py-2 text-[11.5px] leading-snug text-ls-bad-i">
            {summary.error || 'The last run failed.'}
          </p>
        )}
        {summary?.status === 'stopped' && (
          <p className="rounded-[10px] bg-ls-soft px-2.5 py-2 text-xs text-ls-ink2">The last run was stopped. Its partial results are kept.</p>
        )}
        {summary?.status === 'none' && (
          <p className="rounded-[10px] bg-ls-soft px-2.5 py-2 text-xs text-ls-mute">No runs yet. Open it to run a first simulation.</p>
        )}

        <div className="mt-auto flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ls-mute">
            <Clock className="h-3 w-3 shrink-0" />
            <div className="flex flex-col leading-tight">
              <span>{updated.toLocaleDateString()}</span>
              <span className="text-[10px] font-medium">{updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <IconBtn title="View source file" onClick={stop(onView)}><Eye className="h-4 w-4" /></IconBtn>
            <Button size="sm" onClick={stop(onOpen)}>
              <Play className="h-3 w-3" /> Open
            </Button>
            <IconBtn title="Delete" danger onClick={stop(onDelete)}><Trash2 className="h-4 w-4" /></IconBtn>
          </div>
        </div>
      </div>
    </div>
  )
}

function IconBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-[9px] bg-ls-page text-ls-ink2 transition-colors hover:bg-ls-chip',
        danger && 'hover:bg-ls-bad-t hover:text-ls-bad-i'
      )}
    >
      {children}
    </button>
  )
}
