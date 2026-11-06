import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { statusOf, STATUS_LEGEND, type StatusKey } from '@/lib/status'
import type { StationStat } from '@/types'
import { ChartKey, Insight, Stats, useTip } from './ChartKit'

// Station utilization as ranked lanes: busiest first, a tick for the operator's share, and
// status chips to filter by band. Replaces the two bar charts; the numbers are the same.

export default function StationLanes({ stats, onData }: {
  stats: StationStat[]
  onData?: (t: { title: string; columns: string[]; rows: string[][] }) => void
}) {
  const [filter, setFilter] = useState<'all' | StatusKey>('all')
  const { bind, node } = useTip()
  if (stats.length === 0) return null

  const ranked = [...stats].sort((a, b) => b.station_utilization - a.station_utilization)
  const top = ranked[0]
  const avg = stats.reduce((a, s) => a + s.station_utilization, 0) / stats.length
  const max = Math.max(25, Math.ceil((top.station_utilization * 1.15) / 5) * 5)
  const step = max > 50 ? 25 : 5
  const count = (k: StatusKey) => stats.filter((s) => statusOf(s.station_utilization).key === k).length
  const rows = ranked.filter((s) => filter === 'all' || statusOf(s.station_utilization).key === filter)
  const topSt = statusOf(top.station_utilization)

  return (
    <Card className="mb-5">
      {node}
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-ls-ink2">Station utilization</CardTitle>
          {onData && (
            <button
              onClick={() => onData({
                title: 'Station & operator utilization',
                columns: ['Station', 'Utilization', 'Operator', 'Jobs'],
                rows: ranked.map((x) => [x.station_name, `${x.station_utilization.toFixed(1)}%`, `${x.operator_utilization.toFixed(1)}%`, String(x.completed_jobs)]),
              })}
              className="rounded-lg bg-ls-page px-2.5 py-1 text-[11.5px] font-semibold text-ls-ink2 hover:bg-ls-chip"
            >
              Data
            </button>
          )}
        </div>
        <p className="text-xs text-ls-mute">Ranked busiest first · the tick marks the operator's share</p>
      </CardHeader>
      <CardContent>
        <Stats items={[
          { value: `${top.station_utilization.toFixed(0)}%`, label: `busiest · ${top.station_name}`, tone: topSt.key === 'idle' ? undefined : topSt.color },
          { value: `${avg.toFixed(0)}%`, label: 'line average' },
        ]} />

        <div className="mb-3 flex flex-wrap gap-1.5">
          <button onClick={() => setFilter('all')} className={chip(filter === 'all')}>All {stats.length}</button>
          {[...STATUS_LEGEND].sort((a, b) => order(a.key) - order(b.key)).map((s) => (
            <button key={s.key} onClick={() => setFilter(s.key)} className={chip(filter === s.key)}>
              <i className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />
              {s.label} {count(s.key)}
            </button>
          ))}
        </div>

        <div>
          {rows.length === 0 && <p className="py-3 text-[13px] text-ls-mute">No station in this band.</p>}
          {rows.map((s, i) => {
            const st = statusOf(s.station_utilization)
            const u = s.station_utilization
            return (
              <div
                key={s.station_name}
                {...bind(<><div>{s.station_name} · {st.label}</div><div className="font-normal opacity-80">{u.toFixed(1)}% station · {s.operator_utilization.toFixed(1)}% operator · {s.completed_jobs} jobs</div></>)}
                className="grid grid-cols-[22px_120px_1fr_54px] items-center gap-2.5 border-t border-ls-line py-[7px] first:border-t-0"
              >
                <span className="text-xs font-bold text-ls-mute">{i + 1}</span>
                <span className="truncate text-[13px] font-semibold text-ls-ink">{s.station_name}</span>
                <div className="relative h-4 rounded-md bg-ls-chip">
                  <div
                    className="absolute inset-y-0 left-0 rounded-md"
                    style={{
                      width: `${Math.min(100, Math.max((u / max) * 100, u > 0 ? 2 : 0))}%`,
                      background: `color-mix(in srgb, ${st.color} 68%, var(--ls-card))`,
                    }}
                  />
                  {s.operator_utilization > 0 && (
                    <i className="absolute -top-[3px] h-[22px] w-0.5 rounded-sm bg-ls-ink/60" style={{ left: `${Math.min(100, (s.operator_utilization / max) * 100)}%` }} />
                  )}
                </div>
                <span className="text-right text-[13px] font-bold" style={{ color: u > 0 ? st.color : 'var(--ls-mute)' }}>{u > 0 ? `${u.toFixed(1)}%` : '—'}</span>
              </div>
            )
          })}
        </div>

        <div className="mt-1 grid grid-cols-[22px_120px_1fr_54px] gap-2.5 text-[10.5px] text-ls-mute">
          <span /><span />
          <div className="flex justify-between">
            {Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => <span key={i}>{i * step}%</span>)}
          </div>
          <span />
        </div>

        <ChartKey
          colors={[...STATUS_LEGEND].sort((a, b) => order(a.key) - order(b.key)).map((g) => ({ color: g.color, label: g.label, note: g.range }))}
          x="Utilization, % of the run (scale along the bottom)"
          y="Stations, busiest first"
          measure="Utilization is the share of the run a station spent working. The dark tick on each bar is the share its operator was busy."
        />
        <Insight>
          {top.station_utilization >= 70
            ? <><b className="text-ls-ink">{top.station_name} is close to its limit</b> at {top.station_utilization.toFixed(0)}%. A slower station behind it will start to back up.</>
            : <><b className="text-ls-ink">No station is under strain.</b> The busiest, {top.station_name}, is at {top.station_utilization.toFixed(0)}%, so there is room to take on more work.</>}
        </Insight>
      </CardContent>
    </Card>
  )
}

const order = (k: StatusKey) => ['bottleneck', 'high', 'healthy', 'idle'].indexOf(k)

const chip = (on: boolean) =>
  cn(
    'inline-flex items-center gap-1.5 rounded-[10px] border px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
    on ? 'border-ls-dark bg-ls-dark text-ls-page' : 'border-ls-line2 bg-ls-card text-ls-ink2 hover:bg-ls-chip',
  )
