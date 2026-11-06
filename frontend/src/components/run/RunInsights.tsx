import { useState } from 'react'
import { Target } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { statusOf, STATE_COLOR } from '@/lib/status'
import { cn } from '@/lib/utils'
import { ChartKey, Insight, Stats, useTip } from '@/components/run/ChartKit'
import type { RunDetail, StationStat, StationStateStat } from '@/types'

// Pieces of the v2 Analysis design that the engine's data supports: where each station's time
// went, and the bottleneck's vitals.

// ─── Where each station's time went ──────────────────────────────────────────

const SEGMENTS = [
  { key: 'working', label: 'Working', color: STATE_COLOR.working },
  { key: 'setup', label: 'Setup', color: STATE_COLOR.setup },
  { key: 'blocked', label: 'Blocked', color: STATE_COLOR.blocked },
  { key: 'failed', label: 'Failed', color: STATE_COLOR.failed },
  { key: 'free', label: 'Free', color: STATE_COLOR.free },
] as const

type SegKey = (typeof SEGMENTS)[number]['key']

// Reads run.result.station_states (each station's % of operating time in five states).
export function StateCharts({ result, stats, onStation, onData, only }: {
  // Draw just the stacked bars or just the pie (the Analysis graph menu); none = both.
  only?: 'stacked' | 'pie'
  result: RunDetail['result']
  stats: StationStat[]
  onStation?: (name: string) => void
  onData?: (table: { title: string; columns: string[]; rows: string[][] }) => void
}) {
  const [hidden, setHidden] = useState<Set<SegKey>>(new Set())
  const { bind, node } = useTip()
  const states = (result?.station_states ?? {}) as Record<string, StationStateStat>
  const rows = stats.map((s) => ({ name: s.station_name, st: states[s.station_name] })).filter((r) => r.st)
  if (rows.length === 0) return null

  const avg = (k: SegKey) => rows.reduce((a, r) => a + r.st[k], 0) / rows.length
  const toggle = (k: SegKey) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const most = (k: SegKey) => rows.reduce((a, r) => (r.st[k] > a.st[k] ? r : a))
  const blocked = most('blocked')
  const free = most('free')
  const lossKey = (['blocked', 'failed', 'setup', 'free'] as SegKey[]).reduce((a, k) => (avg(k) > avg(a) ? k : a))

  const legend = (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {SEGMENTS.map((g) => (
        <button
          key={g.key}
          onClick={() => toggle(g.key)}
          className={cn('inline-flex items-center gap-1.5 text-[11.5px] text-ls-ink2 transition-opacity', hidden.has(g.key) && 'opacity-40')}
          title={hidden.has(g.key) ? `Show ${g.label}` : `Hide ${g.label}`}
        >
          <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: g.color }} />
          {g.label} <b className="text-[11.5px] font-semibold text-ls-ink">{avg(g.key).toFixed(0)}%</b>
        </button>
      ))}
    </div>
  )

  // Donut: the average split across stations
  const shown = SEGMENTS.filter((g) => !hidden.has(g.key))
  const total = shown.reduce((a, g) => a + avg(g.key), 0) || 1
  const R = 52
  const C = 2 * Math.PI * R
  let acc = 0

  return (
    <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
      {node}
      {only !== 'pie' && <Card className={only ? 'lg:col-span-3' : 'lg:col-span-2'}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold text-ls-ink2">Time by state per station</CardTitle>
            {onData && (
              <button
                onClick={() => onData({
                  title: 'Time by state per station',
                  columns: ['Station', ...SEGMENTS.map((g) => g.label)],
                  rows: rows.map((r) => [r.name, ...SEGMENTS.map((g) => `${r.st[g.key].toFixed(1)}%`)]),
                })}
                className="rounded-lg bg-ls-page px-2.5 py-1 text-[11.5px] font-semibold text-ls-ink2 hover:bg-ls-chip"
              >
                Data
              </button>
            )}
          </div>
          <p className="text-xs text-ls-mute">Each bar is 100% of a station's operating time · click a station for its details</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {legend}
          <div className="space-y-2">
            {rows.map((r) => {
              const lost = 100 - r.st.working
              return (
                <div
                  key={r.name}
                  onClick={() => onStation?.(r.name)}
                  className={cn('flex items-center gap-3 rounded-md text-xs', onStation && 'cursor-pointer hover:bg-ls-soft')}
                >
                  <span className="w-28 shrink-0 truncate font-medium text-ls-ink2" title={r.name}>{r.name}</span>
                  <div className="flex h-6 flex-1 gap-0.5 overflow-hidden rounded-lg bg-ls-chip">
                    {SEGMENTS.filter((g) => !hidden.has(g.key) && r.st[g.key] > 0).map((g) => (
                      <i
                        key={g.key}
                        {...bind(<><div>{r.name} · {g.label}</div><div className="font-normal opacity-80">{r.st[g.key].toFixed(1)}% of its operating time</div></>)}
                        className="flex items-center justify-center rounded-md text-[10px] font-bold not-italic text-white"
                        style={{ width: `${r.st[g.key]}%`, background: g.color, boxShadow: '1px 2px 2px rgba(16,24,40,.18)' }}
                      >
                        {r.st[g.key] >= 9 ? `${r.st[g.key].toFixed(0)}%` : ''}
                      </i>
                    ))}
                  </div>
                  <span
                    className="w-[84px] shrink-0 whitespace-nowrap rounded-[10px] px-2 py-0.5 text-center text-[11px] font-bold"
                    style={lost >= 40 ? { background: 'var(--ls-bad-t)', color: 'var(--ls-bad-i)' } : lost >= 20 ? { background: 'var(--ls-warn-t)', color: 'var(--ls-warn-i)' } : { background: 'var(--ls-chip)', color: 'var(--ls-ink2)' }}
                    {...bind('Everything that is not working: setup, blocked, failed and free time')}
                  >
                    Lost {lost.toFixed(0)}%
                  </span>
                </div>
              )
            })}
          </div>
          <ChartKey
            x="Share of the station's operating time; each bar adds up to 100%"
            y="Stations"
            measure={<>Working: processing a job · Setup: setup and rework · Blocked: finished but cannot pass the job on · Failed: broken down · Free: waiting for a job · Lost: everything except Working.</>}
          />
          <Insight>
            <b className="text-ls-ink">{blocked.name} is blocked most,</b> {blocked.st.blocked.toFixed(0)}% of the time; {free.name} is free most, {free.st.free.toFixed(0)}%. "Lost" is everything that is not working.
          </Insight>
        </CardContent>
      </Card>}

      {only !== 'stacked' && <Card className={cn('flex flex-col', only && 'lg:col-span-3')}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-ls-ink2">Time share</CardTitle>
          <p className="text-xs text-ls-mute">Average across {rows.length} station{rows.length === 1 ? '' : 's'} · click a state to hide it</p>
        </CardHeader>
        <CardContent className={cn('flex flex-1 flex-col gap-5', only && 'lg:flex-row lg:items-center lg:gap-10')}>
          <div className={cn('flex justify-center', only && 'lg:flex-1')}>
            <svg viewBox="0 0 140 140" className={cn('block', only ? 'w-64' : 'w-48')}>
              <g transform="rotate(-90 70 70)">
                {shown.map((g) => {
                  const len = (avg(g.key) / total) * C
                  const el = (
                    <circle
                      key={g.key} data-tip={`${g.label}
${avg(g.key).toFixed(1)}% of operating time, averaged across stations`} cx="70" cy="70" r={R} fill="none" stroke={g.color} strokeWidth="22"
                      strokeDasharray={`${Math.max(0, len - 1.5)} ${C - len + 1.5}`} strokeDashoffset={-acc}
                    />
                  )
                  acc += len
                  return el
                })}
              </g>
              <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--ls-ink)">{avg('working').toFixed(0)}%</text>
              <text x="70" y="83" textAnchor="middle" fontSize="9" fill="var(--ls-mute)">working</text>
            </svg>
          </div>
          <div className={cn('flex flex-col', only && 'lg:flex-1')}>
            <div className="space-y-1">
              {[...SEGMENTS].sort((x, y) => avg(y.key) - avg(x.key)).map((g) => (
                <button
                  key={g.key}
                  onClick={() => toggle(g.key)}
                  data-tip={`${g.label}
${avg(g.key).toFixed(1)}% of operating time
${hidden.has(g.key) ? 'Click to show' : 'Click to hide'}`}
                  className={cn('grid w-full grid-cols-[12px_58px_1fr_40px] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition-opacity hover:bg-ls-soft', hidden.has(g.key) && 'opacity-40')}
                >
                  <i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: g.color }} />
                  <span className="font-medium text-ls-ink2">{g.label}</span>
                  <span className="h-2 overflow-hidden rounded-md bg-ls-chip">
                    <i className="block h-full rounded-md" style={{ width: `${Math.min(100, avg(g.key))}%`, background: g.color }} />
                  </span>
                  <b className="text-right font-semibold text-ls-ink">{avg(g.key).toFixed(0)}%</b>
                </button>
              ))}
            </div>
            <div className="mt-auto">
              <ChartKey measure="Each slice is one state's share of operating time, averaged across all stations. The centre shows the Working share. Colours match the stacked bar." />
              <Insight>
                <b className="text-ls-ink">Working {avg('working').toFixed(0)}% of the time.</b> {SEGMENTS.find((g) => g.key === lossKey)!.label} is the largest loss at {avg(lossKey).toFixed(0)}%.
              </Insight>
            </div>
          </div>
        </CardContent>
      </Card>}
    </div>
  )
}

// ─── The bottleneck's vitals (Detect tab) ────────────────────────────────────

export function BottleneckPanel({ bottleneck, result, order, repairMin }: { bottleneck: StationStat | null; result: RunDetail['result']; order?: string[]; repairMin?: number }) {
  if (!bottleneck) return null
  const st = ((result?.station_states ?? {}) as Record<string, StationStateStat>)[bottleneck.station_name]
  const s = statusOf(bottleneck.station_utilization)
  const tiles: [string, string][] = [
    ['Utilisation', `${bottleneck.station_utilization.toFixed(1)}%`],
    ['Blocked', `${(st ? st.blocked : bottleneck.buffer_blocked_ratio).toFixed(1)}%`],
    ['Failures', String(bottleneck.failure_breakdowns)],
    ['Rework', `${bottleneck.rework_percentage.toFixed(1)}%`],
    ['Availability', st ? `${(100 - st.failed).toFixed(1)}%` : '—'],
    ['Repair time', repairMin != null ? `${repairMin} min` : '—'],
  ]
  // Who waits on whom: stations before the bottleneck (in route order) are blocked, those after it wait for work.
  const states = (result?.station_states ?? {}) as Record<string, StationStateStat>
  const at = order?.indexOf(bottleneck.station_name) ?? -1
  const range = (names: string[], k: 'blocked' | 'free') => {
    const v = names.map((n) => states[n]?.[k]).filter((x): x is number => x != null)
    return v.length ? `${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)}%` : null
  }
  const up = at > 0 ? range(order!.slice(0, at), 'blocked') : null
  const down = at >= 0 && order ? range(order.slice(at + 1), 'free') : null
  return (
    <Card className="mb-5">
      <CardContent className="flex flex-wrap items-center gap-4 py-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-ls-crim-t text-ls-crim"><Target className="h-5 w-5" /></span>
        <div className="min-w-[200px] flex-1">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ls-mute">Bottleneck</p>
          <h3 className="font-display text-xl font-bold text-ls-ink">{bottleneck.station_name}</h3>
          <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: s.tint, color: s.ink }}>{s.label}</span>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {tiles.map(([l, v]) => (
            <div key={l} className="rounded-xl bg-ls-soft px-3 py-2">
              <span className="block text-[10.5px] font-semibold text-ls-mute">{l}</span>
              <b className="font-display text-base font-bold text-ls-ink">{v}</b>
            </div>
          ))}
        </div>
        {(up || down) && (
          <p className="basis-full text-xs text-ls-mute">
            {bottleneck.station_name} is the constraint.{up ? ` Stations before it are blocked ${up} of the time because the buffers after them fill up.` : ''}{down ? ` Stations after it are free ${down} of the time, waiting for parts.` : ''}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Throughput by station ──────────────────────────────────────────────────

// Jobs per hour each station handled over the run, against what the whole line delivered.
export function StationThroughput({ stats, bottleneck, lineOutput }: { stats: StationStat[]; bottleneck: string | null; lineOutput: number | null }) {
  const rows = [...stats].sort((a, b) => b.throughput - a.throughput)
  if (rows.length === 0) return null
  const mx = Math.max(...rows.map((r) => r.throughput), lineOutput ?? 0, 0.0001) * 1.08
  const top = rows[0]
  const slow = rows[rows.length - 1]
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => +(mx * f).toFixed(2))
  return (
    <Card className="mb-5">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold text-ls-ink2">Throughput by station</CardTitle>
        <p className="text-xs text-ls-mute">Ranked by jobs per hour{lineOutput != null ? ' · the dashed line is what the whole line delivered' : ''}</p>
      </CardHeader>
      <CardContent>
        <Stats items={[
          { value: top.throughput.toFixed(2), label: `jobs/hr · highest, ${top.station_name}` },
          ...(lineOutput != null ? [{ value: lineOutput.toFixed(2), label: 'jobs/hr · line output' }] : []),
        ]} />
        <div>
          {rows.map((r, i) => {
            const isB = r.station_name === bottleneck
            const c = isB ? 'var(--ls-bad)' : 'var(--ls-accent)'
            return (
              <div
                key={r.station_name}
                data-tip={`${r.station_name}${isB ? ' · bottleneck' : ''}
${r.throughput.toFixed(2)} jobs/hr${lineOutput != null ? ` (line output ${lineOutput.toFixed(2)} jobs/hr)` : ''}`}
                className="grid grid-cols-[22px_120px_1fr_54px] items-center gap-2.5 border-t border-ls-line py-[7px] first:border-t-0"
              >
                <span className="text-xs font-bold text-ls-mute">{i + 1}</span>
                <span className={cn('truncate text-[13px] text-ls-ink', isB ? 'font-bold' : 'font-semibold')}>{r.station_name}</span>
                <div className="relative h-4 rounded-md bg-ls-chip">
                  <div
                    className="absolute inset-y-0 left-0 rounded-md"
                    style={{
                      width: `${Math.min(100, Math.max((r.throughput / mx) * 100, r.throughput > 0 ? 2 : 0))}%`,
                      background: `color-mix(in srgb, ${c} 68%, var(--ls-card))`,
                    }}
                  />
                  {lineOutput != null && <i className="absolute -top-[3px] h-[22px] w-0.5 rounded-sm bg-ls-ink/60" style={{ left: `${Math.min(100, (lineOutput / mx) * 100)}%` }} />}
                </div>
                <span className="text-right text-[13px] font-bold" style={{ color: r.throughput > 0 ? c : 'var(--ls-mute)' }}>{r.throughput > 0 ? r.throughput.toFixed(2) : '—'}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-1 grid grid-cols-[22px_120px_1fr_54px] gap-2.5 text-[10.5px] text-ls-mute">
          <span /><span />
          <div className="flex justify-between">{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
          <span />
        </div>
        <ChartKey
          colors={[
            { color: 'color-mix(in srgb, var(--ls-accent) 68%, var(--ls-card))', label: 'Station', note: 'jobs it finished per hour' },
            { color: 'color-mix(in srgb, var(--ls-bad) 68%, var(--ls-card))', label: 'Bottleneck', note: 'the busiest station' },
            ...(lineOutput != null ? [{ color: 'var(--ls-ink)', label: 'Line output', note: 'jobs per hour the whole line delivered', dashed: true }] : []),
          ]}
          x="Jobs per hour (scale along the bottom)"
          y="Stations, most jobs first"
          measure="Throughput is the number of jobs a station finished per hour of the run."
        />
        <Insight>
          <b className="text-ls-ink">{slow.station_name} handled the least,</b> {slow.throughput.toFixed(2)} jobs/hr{lineOutput != null ? `; the line delivered ${lineOutput.toFixed(2)} jobs/hr` : ''}.{bottleneck ? ` ${bottleneck} is the bottleneck (shown in red).` : ''}
        </Insight>
      </CardContent>
    </Card>
  )
}
