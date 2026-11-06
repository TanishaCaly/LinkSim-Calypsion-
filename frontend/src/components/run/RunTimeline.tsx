import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/store/useAppStore'
import { jobPrefix } from '@/lib/variantColors'
import { ChartKey, ChartTip, Insight, Stats } from './ChartKit'
import type { ProcessStep, StationStat } from '@/types'

// Line charts over the run's own clock, built from the completion log (every station
// visit of every job with its start and end time): output per period, cumulative output,
// jobs in the line, and each station's busy share per period. Nothing is estimated.

interface Visit { station: string; start: number; end: number | null; wait: number }

const parseT = (s: unknown): number | null => {
  if (typeof s !== 'string' || !s) return null
  const t = new Date(s.replace(' ', 'T')).getTime()
  return Number.isFinite(t) ? t : null
}

const stepNames = (st: ProcessStep): string[] => {
  const r = st.resource
  return typeof r === 'string' ? [r] : r?.options ?? []
}

// "Day 3" / "14 h" / "40 min" for an offset from the start of the run
const elapsed = (min: number) => (min >= 2880 ? `Day ${Math.floor(min / 1440) + 1}` : min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`)
const span = (min: number) => (min >= 1440 ? `${+(min / 1440).toFixed(1)} day${min >= 2880 ? 's' : ''}` : min >= 60 ? `${+(min / 60).toFixed(1)} h` : `${Math.round(min)} min`)

const N = 40

export function buildRunSeries(completionLog: Record<string, unknown[]>, flows: Record<string, ProcessStep[]>, stats: StationStat[]) {
  const jobs = new Map<string, { arrival: number; visits: Visit[] }>()
  let tMax = -Infinity
  const busy: Record<string, [number, number][]> = {}
  for (const [station, entries] of Object.entries(completionLog)) {
    for (const e of entries as Record<string, unknown>[]) {
      const start = parseT(e['process_start_time_real'])
      if (start === null) continue
      const end = parseT(e['process_end_time_real'])
      const wait = Number(e['Blocked Time'] ?? 0) * 60000
      const id = String(e['job_id'] ?? '')
      const j = jobs.get(id) ?? { arrival: Infinity, visits: [] }
      j.arrival = Math.min(j.arrival, start - wait)
      j.visits.push({ station, start, end, wait })
      jobs.set(id, j)
      if (end !== null) { tMax = Math.max(tMax, end); (busy[station] ??= []).push([start, end]) }
    }
  }
  if (jobs.size === 0 || !Number.isFinite(tMax)) return null
  const t0 = Math.min(...[...jobs.values()].map((j) => j.arrival))
  if (!(tMax > t0)) return null
  const width = (tMax - t0) / N

  // A job is finished when it has been through the last step of its product's route.
  const variants = Object.keys(flows).sort((a, b) => b.length - a.length)
  const lastOf = (id: string) => {
    const v = variants.find((k) => id.toLowerCase().startsWith(k.toLowerCase())) ?? variants.find((k) => jobPrefix(id) === k) ?? variants[0]
    const steps = v ? flows[v] : []
    return new Set(steps.length ? stepNames(steps[steps.length - 1]) : [])
  }
  const finish = new Map<string, number>()
  for (const [id, j] of jobs) {
    const last = lastOf(id)
    const ends = j.visits.filter((v) => last.has(v.station.replace(/\s+#\d+$/, '')) || last.has(v.station)).map((v) => v.end).filter((x): x is number => x !== null)
    if (ends.length) finish.set(id, Math.max(...ends))
  }

  const caps: Record<string, number> = Object.fromEntries(stats.map((s) => [s.station_name, Math.max(1, s.capacity || 1)]))
  const rows = Array.from({ length: N }, (_, i) => {
    const a = t0 + i * width
    const b = a + width
    const done = [...finish.values()].filter((f) => f > a && f <= b).length
    const cum = [...finish.values()].filter((f) => f <= b).length
    const wip = [...jobs].filter(([id, j]) => j.arrival <= b && (finish.get(id) ?? Infinity) > b).length
    const r: Record<string, number | string> = { i, x: elapsed(((a + b) / 2 - t0) / 60000), done, cum, wip }
    for (const st of Object.keys(busy)) {
      const ms = busy[st].reduce((acc, [s, e]) => acc + Math.max(0, Math.min(e, b) - Math.max(s, a)), 0)
      r[st] = Math.min(100, Math.round((ms / (width * (caps[st] ?? 1))) * 1000) / 10)
    }
    const shares = Object.keys(busy).map((st) => r[st] as number)
    r.avg = shares.length ? shares.reduce((x, y) => x + y, 0) / shares.length : 0
    r.peak = shares.length ? Math.max(...shares) : 0
    return r
  })
  return { rows, bucketMin: width / 60000, spanMin: (tMax - t0) / 60000, stations: Object.keys(busy), finished: finish.size, total: jobs.size }
}

/** The run's series (output, running total, jobs in the line, busy share) for charts and KPI sparklines. */
export function useRunSeries(completionLog: Record<string, unknown[]> | undefined, stats: StationStat[]) {
  const scenario = useAppStore((s) => s.activeScenario)
  return useMemo(() => (completionLog ? buildRunSeries(completionLog, scenario?.processflow_data ?? {}, stats) : null), [completionLog, scenario, stats])
}

export default function RunTimeline({ data, onData, only }: {
  data: ReturnType<typeof buildRunSeries>
  // Draw just one of the charts (the Analysis graph menu); none = all three.
  only?: 'line' | 'area'
  onData?: (t: { title: string; columns: string[]; rows: string[][] }) => void
}) {
  const isDark = useAppStore((s) => s.theme) === 'dark'
  const scenario = useAppStore((s) => s.activeScenario)
  if (!data) return null
  // The planned jobs (every variant's quantity) is the target the running total is heading for
  const target = Object.values(scenario?.variant_quantities ?? {}).reduce((a, b) => a + Number(b || 0), 0)

  const grid = isDark ? '#2A2F37' : '#EDF0F4'
  const tick = isDark ? '#8C96A7' : '#667085'
  const per = span(data.bucketMin)
  const total = data.rows.reduce((a, r) => a + (r.done as number), 0)
  const labelOf = (i: string | number | undefined) => String(data.rows[Number(i)]?.x ?? '')
  const peakDone = data.rows.reduce((a, r) => ((r.done as number) > (a.done as number) ? r : a))
  const peakWip = data.rows.reduce((a, r) => ((r.wip as number) > (a.wip as number) ? r : a))
  const axis = { stroke: tick, fontSize: 10, tickLine: false, axisLine: false } as const
  const cursor = { stroke: tick, strokeDasharray: '4 4', strokeOpacity: 0.6 }

  const card = (title: string, take: React.ReactNode, chart: React.ReactNode, table: { columns: string[]; rows: string[][] }, cls = '', extra?: React.ReactNode, sub?: string, key?: React.ReactNode) => (
    <Card className={cls}>
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-ls-ink2">{title}</CardTitle>
          {onData && (
            <button onClick={() => onData({ title, ...table })} className="rounded-lg bg-ls-page px-2.5 py-1 text-[11.5px] font-semibold text-ls-ink2 hover:bg-ls-chip">Data</button>
          )}
        </div>
        {sub && <p className="text-xs text-ls-mute">{sub}</p>}
      </CardHeader>
      <CardContent>
        {extra}
        <div className="h-[240px]">{chart}</div>
        {key}
        <Insight>{take}</Insight>
      </CardContent>
    </Card>
  )

  return (
    <div className="mb-5 space-y-5">
      <p className="-mt-1 text-xs text-ls-mute">{span(data.spanMin)} of activity · one point per {per}</p>

      {(!only || only === 'line') && card(
        'Output over time',
        <><b className="text-ls-ink">Output peaks around {peakDone.x}</b> at {peakDone.done} job{peakDone.done === 1 ? '' : 's'} per {per}; {total} finished over the run.</>,
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.rows} margin={{ top: 30, right: 12, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="done-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--ls-accent)" stopOpacity=".35" />
                <stop offset="1" stopColor="var(--ls-accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={grid} vertical={false} />
            <XAxis dataKey="i" {...axis} interval="preserveStartEnd" minTickGap={28} tickFormatter={labelOf} />
            <YAxis {...axis} allowDecimals={false} />
            <Tooltip cursor={cursor} content={<ChartTip unit="jobs" name={`Finished per ${per}`} labelOf={labelOf} />} />
            <Area type="monotone" dataKey="done" stroke="var(--ls-accent)" strokeWidth={2.6} fill="url(#done-fill)" dot={false} activeDot={{ r: 5, fill: 'var(--ls-accent)', stroke: 'var(--ls-card)', strokeWidth: 2 }} />
            <ReferenceDot x={peakDone.i as number} y={peakDone.done as number} r={6} fill="var(--ls-accent)" stroke="var(--ls-card)" strokeWidth={2.5} label={{ value: `Peak ${peakDone.done}`, position: 'top', fill: 'var(--ls-accent)', fontSize: 11, fontWeight: 700 }} />
          </AreaChart>
        </ResponsiveContainer>,
        { columns: ['Time', `Finished per ${per}`], rows: data.rows.map((r) => [String(r.x), String(r.done)]) },
        '',
        <Stats items={[{ value: String(total), label: 'jobs finished' }, { value: String(peakDone.done), label: `most in one ${per}` }]} />,
        `One point per ${per}`,
        <ChartKey
          colors={[{ color: 'var(--ls-accent)', label: 'Jobs finished', note: 'in each period' }, { color: 'var(--ls-accent)', label: 'Peak', note: 'the busiest period' }]}
          x={`Time since the run started, one point per ${per}`}
          y="Jobs finished in that period"
          measure="A job counts as finished once it has been through the last step of its route."
        />,
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {(!only || only === 'area') && card(
          'Cumulative output',
          target > 0
            ? <><b className="text-ls-ink">{data.finished} of {target} planned jobs are done</b> ({Math.round((data.finished / target) * 100)}%).{data.finished < target ? ' The gap to the dashed line is work not finished in this run.' : ''}</>
            : <><b className="text-ls-ink">{data.finished} of {data.total} jobs</b> reached the end of their route.</>,
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.rows} margin={{ top: 14, right: 12, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="cum-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--ls-accent)" stopOpacity=".35" />
                  <stop offset="1" stopColor="var(--ls-accent)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="x" {...axis} interval="preserveStartEnd" minTickGap={28} />
              <YAxis {...axis} allowDecimals={false} domain={[0, (max: number) => Math.max(max, target)]} />
              <Tooltip cursor={cursor} content={<ChartTip unit="jobs" name="Finished so far" />} />
              {target > 0 && <ReferenceLine y={target} stroke={tick} strokeDasharray="5 4" label={{ value: `Planned ${target}`, fill: tick, fontSize: 10, position: 'insideTopLeft' }} />}
              <Area type="monotone" dataKey="cum" stroke="var(--ls-accent)" strokeWidth={2.6} fill="url(#cum-fill)" dot={false} activeDot={{ r: 5, fill: 'var(--ls-accent)', stroke: 'var(--ls-card)', strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>,
          { columns: ['Time', 'Finished so far'], rows: data.rows.map((r) => [String(r.x), String(r.cum)]) },
          only ? 'lg:col-span-3' : 'lg:col-span-2',
          <Stats items={[{ value: String(data.finished), label: 'jobs finished' }, ...(target > 0 ? [{ value: `${Math.round((data.finished / target) * 100)}%`, label: `of the ${target} planned` }] : [])]} />,
          'Running total over the run',
          <ChartKey
            colors={[{ color: 'var(--ls-accent)', label: 'Finished so far' }, ...(target > 0 ? [{ color: 'var(--ls-ink2)', label: 'Planned total', note: 'every job in the scenario', dashed: true }] : [])]}
            x="Time since the run started"
            y="Total jobs finished so far (running total)"
            measure="The gap between the line and the planned total is work not finished in this run."
          />,
        )}
        {!only && card(
          'Jobs in the line',
          <><b className="text-ls-ink">Peak {peakWip.wip} jobs</b> around {peakWip.x}. A job counts from its first arrival until it finishes.</>,
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.rows} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="wip-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--ls-purple)" stopOpacity=".35" />
                  <stop offset="1" stopColor="var(--ls-purple)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="x" {...axis} interval="preserveStartEnd" minTickGap={36} />
              <YAxis {...axis} allowDecimals={false} />
              <Tooltip cursor={cursor} content={<ChartTip unit="jobs" name="In the line" />} />
              <Area type="monotone" dataKey="wip" stroke="var(--ls-purple)" strokeWidth={2.6} fill="url(#wip-fill)" dot={false} activeDot={{ r: 5, fill: 'var(--ls-purple)', stroke: 'var(--ls-card)', strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>,
          { columns: ['Time', 'Jobs in the line'], rows: data.rows.map((r) => [String(r.x), String(r.wip)]) },
          '',
          undefined,
          undefined,
          <ChartKey
            colors={[{ color: 'var(--ls-purple)', label: 'Jobs in the line' }]}
            x={`Time since the run started, one point per ${per}`}
            y="Jobs in the line at that time"
            measure="A job counts from its first arrival until it finishes."
          />,
        )}
      </div>
    </div>
  )
}
