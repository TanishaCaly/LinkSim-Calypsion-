import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/store/useAppStore'
import { parseJobTrace } from '@/lib/jobTrace'
import { ChartKey, ChartTip, Insight, Stats } from './ChartKit'

// How long jobs spent in the line: for each job, from the moment it first reached a station (its first
// process start minus the queue wait before it) to the end of its last visit. Read from the run's job log.

const BINS = 10
const ms = (s: string | null) => (s ? new Date(s.replace(' ', 'T')).getTime() : NaN)

// Show the unit that fits the run: minutes for short runs, hours up to 4 days, days beyond.
const unitFor = (maxMin: number) => (maxMin < 120 ? { k: 1, u: 'min' } : maxMin < 5760 ? { k: 60, u: 'h' } : { k: 1440, u: 'd' })

export default function LeadTimeHistogram({ completionLog, onData }: {
  completionLog: Record<string, unknown[]> | undefined
  onData?: (t: { title: string; columns: string[]; rows: string[][] }) => void
}) {
  const isDark = useAppStore((s) => s.theme) === 'dark'
  const hist = useMemo(() => {
    if (!completionLog) return null
    const jobs = new Map<string, { from: number; to: number }>()
    for (const r of parseJobTrace(completionLog)) {
      const end = ms(r.departure)
      const start = ms(r.arrival) - (r.waitingMin ?? 0) * 60000
      if (!Number.isFinite(end) || !Number.isFinite(start)) continue
      const j = jobs.get(r.jobId)
      if (j) { j.from = Math.min(j.from, start); j.to = Math.max(j.to, end) } else jobs.set(r.jobId, { from: start, to: end })
    }
    const leads = [...jobs.values()].map((j) => (j.to - j.from) / 60000).filter((m) => m >= 0)
    if (leads.length === 0) return null
    const sorted = [...leads].sort((a, b) => a - b)
    const lo = sorted[0]
    const hi = sorted[sorted.length - 1]
    const { k, u } = unitFor(hi)
    const w = (hi - lo) / BINS || 1
    const fmt = (m: number) => +(m / k).toFixed(k === 1 || k === 60 ? 0 : 1)
    const slowFrom = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
    const bins = Array.from({ length: BINS }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, jobs: 0 }))
    for (const m of leads) bins[Math.min(BINS - 1, Math.floor((m - lo) / w))].jobs++
    const counts = bins.map((b) => ({ x: `${fmt(b.from)}–${fmt(b.to)}`, pct: Math.round((b.jobs / leads.length) * 100), jobs: b.jobs, slow: b.from >= slowFrom }))
    const avg = leads.reduce((a, b) => a + b, 0) / leads.length
    const busiest = bins.reduce((a, b) => (b.jobs > a.jobs ? b : a))
    return { counts, n: leads.length, avg, lo, hi, u, fmt, slowFrom, busiest }
  }, [completionLog])
  if (!hist) return null

  const grid = isDark ? '#2A2F37' : '#EDF0F4'
  const tick = isDark ? '#8C96A7' : '#667085'
  const axis = { stroke: tick, fontSize: 10, tickLine: false, axisLine: false } as const
  const { u, fmt } = hist

  return (
    <Card className="mb-5">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-ls-ink2">Time jobs spent in the line</CardTitle>
          {onData && (
            <button
              onClick={() => onData({ title: 'Time jobs spent in the line', columns: [`Range (${u})`, 'Jobs', 'Share of jobs'], rows: hist.counts.map((c) => [c.x, String(c.jobs), `${c.pct}%`]) })}
              className="rounded-lg bg-ls-page px-2.5 py-1 text-[11.5px] font-semibold text-ls-ink2 hover:bg-ls-chip"
            >
              Data
            </button>
          )}
        </div>
        <p className="text-xs text-ls-mute">Share of jobs by {u === 'd' ? 'days' : u === 'h' ? 'hours' : 'minutes'} in the line, from arriving at the first station to leaving the last</p>
      </CardHeader>
      <CardContent>
        <Stats items={[
          { value: `${fmt(hist.avg)} ${u}`, label: 'average' },
          { value: `${fmt(hist.lo)} ${u}`, label: 'fastest job' },
          { value: `${fmt(hist.hi)} ${u}`, label: 'slowest job' },
        ]} />
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hist.counts} margin={{ top: 18, right: 12, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="hist-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--ls-accent)" stopOpacity=".75" />
                  <stop offset="1" stopColor="var(--ls-accent)" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="x" {...axis} interval={0} />
              <YAxis {...axis} allowDecimals={false} tickFormatter={(v) => `${v}%`} />
              <Tooltip cursor={{ fill: 'var(--ls-chip)', opacity: 0.5 }} content={<ChartTip unit="% of jobs" name={`${u === 'min' ? 'Minutes' : u === 'h' ? 'Hours' : 'Days'} in the line`} />} />
              <Bar dataKey="pct" radius={[8, 8, 0, 0]} label={{ position: 'top', fontSize: 10.5, fontWeight: 700, fill: 'var(--ls-ink)', formatter: (v: unknown) => (Number(v) > 0 ? `${v}%` : '') }}>
                {hist.counts.map((c, i) => <Cell key={i} fill={c.slow ? 'var(--ls-warn)' : 'url(#hist-fill)'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ChartKey
          colors={[
            { color: 'var(--ls-accent)', label: 'Most jobs' },
            ...(hist.counts.some((c) => c.slow) ? [{ color: 'var(--ls-warn)', label: 'Slowest 1 in 10 jobs', note: `longer than ${fmt(hist.slowFrom)} ${u}` }] : []),
          ]}
          x={`Time a job spent in the line, in ${u === 'd' ? 'days' : u === 'h' ? 'hours' : 'minutes'}, grouped into ranges`}
          y="Share of finished jobs in each range (%)"
          measure="Time in the line runs from a job reaching its first station to leaving its last. Average, fastest and slowest are over all finished jobs."
        />
        <Insight>
          <b className="text-ls-ink">Most jobs take {fmt(hist.busiest.from)}–{fmt(hist.busiest.to)} {u},</b> but one in ten takes more than {fmt(hist.slowFrom)} {u}. {hist.counts.some((c) => c.slow) && ' The amber bars are those slow jobs, where the queueing is.'}
        </Insight>
      </CardContent>
    </Card>
  )
}
