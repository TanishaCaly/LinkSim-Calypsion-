import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, RefreshCw, AlertTriangle, CheckCircle, Clock, TrendingUp, Zap, Activity, Target, AlertCircle, BarChart2, Settings, CalendarDays, Layers, X, Lightbulb, Printer, Expand, Shrink, Search, Square, Timer } from 'lucide-react'
import type { SimConfigOverride } from '@/api/simulations'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import type { RunDetail, StationStat, WorkerPoolStat, StationStateStat, BufferStateStat, PartsFlow } from '@/types'
import { SimConfigDialog, SimTimerDialog } from '@/components/run/SimDialogs'
import SimSettingsMenu from '@/components/run/SimSettingsMenu'
import { useRunSimulation } from '@/hooks/useRunSimulation'
import { StateCharts, BottleneckPanel, StationThroughput } from '@/components/run/RunInsights'
import { SectionHeading, SectionNav } from '@/components/run/Sections'
import GraphMenu, { GRAPHS, type GraphKey } from '@/components/run/GraphMenu'
import LeadTimeHistogram from '@/components/run/LeadTimeHistogram'
import ShiftHeatmap from '@/components/run/ShiftHeatmap'
import StationLanes from '@/components/run/StationLanes'
import { parseJobTrace } from '@/lib/jobTrace'
import RunTimeline, { useRunSeries } from '@/components/run/RunTimeline'
import Sparkline from '@/components/run/Sparkline'
import { ChartKey, TipHost } from '@/components/run/ChartKit'
import { Drawer, DataTable, type DataTableProps } from '@/components/run/Drawer'
import StationDrawer from '@/components/run/StationDrawer'
import { statusOf } from '@/lib/status'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary'; label: string }> = {
    pending:   { variant: 'secondary', label: 'Pending' },
    running:   { variant: 'warning',   label: 'Running…' },
    completed: { variant: 'success',   label: 'Completed' },
    failed:    { variant: 'destructive', label: 'Failed' },
  }
  const cfg = map[status] ?? { variant: 'secondary', label: status }
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

function utilColor(u: number) {
  return statusOf(u).color
}

function utilBg(u: number) {
  if (u >= 85) return 'bg-red-50 border-red-200'
  if (u >= 70) return 'bg-amber-50 border-amber-200'
  if (u >= 40) return 'bg-green-50 border-green-200'
  return 'bg-gray-50 border-gray-200'
}

function utilTextColor(u: number) {
  if (u >= 85) return 'text-red-600'
  if (u >= 70) return 'text-amber-600'
  if (u >= 40) return 'text-green-600'
  return 'text-gray-400'
}

// ─── Completed Jobs modal card ───────────────────────────────────────────────

function CompletedJobsCard({ completed, inProgress, scrapped, stats, spark }: { completed: number; inProgress: number; scrapped: number; stats: StationStat[]; spark?: number[] }) {
  const [open, setOpen] = useState(false)
  const sorted = [...stats].sort((a, b) => b.completed_jobs - a.completed_jobs)
  const maxJobs = sorted[0]?.completed_jobs || 1

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Jobs that finished their whole route in this run." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Completed Jobs</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{completed}</p>
              {/* "In progress" here means "not yet finished the whole route" —
                  it includes jobs still mid-station AND jobs that haven't
                  even started yet, not just jobs actively being worked on
                  right now. "Still to finish" says that honestly; "still in
                  progress" reads as "currently being worked on", which a
                  per-station Completed count (further along than this
                  run-wide figure at any one station) can look contradictory
                  against. */}
              <p className="text-xs text-gray-400 mt-1">
                {inProgress > 0 ? `${inProgress} still to finish` : scrapped > 0 ? 'None still in progress' : 'All jobs finished'}
                {scrapped > 0 && ` · ${scrapped} scrapped`}
              </p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50"><CheckCircle className="h-4 w-4 text-blue-500" /></div>
          </div>
          {spark && <Sparkline values={spark} color="var(--ls-accent)" label="Jobs finished so far" />}
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center"><CheckCircle className="h-5 w-5 text-blue-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Completed Jobs per Station</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Total jobs finished · sorted by highest</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Total Completed</p><p className="text-sm font-bold text-blue-600">{completed}</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Top Station</p><p className="text-sm font-bold text-gray-800">{sorted[0]?.station_name ?? '—'}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-44 text-center">Jobs</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Count</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-blue-50/40' : 'hover:bg-gray-50'}`}>
                  <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                  <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                  <div className="w-44 h-2.5 bg-gray-100 rounded-full overflow-hidden shrink-0">
                    <div className="h-full rounded-full bg-blue-400" style={{ width: `${(s.completed_jobs / maxJobs) * 100}%` }} />
                  </div>
                  <span className="text-sm font-bold text-blue-700 tabular-nums w-20 text-right">{s.completed_jobs}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Peak Utilization modal card ─────────────────────────────────────────────

function PeakUtilCard({ peakUtil, bottleneck, stats, spark }: { peakUtil: number; bottleneck: StationStat | null; stats: StationStat[]; spark?: number[] }) {
  const [open, setOpen] = useState(false)
  const sorted = [...stats].sort((a, b) => b.station_utilization - a.station_utilization)

  return (
    <div className="relative h-full">
      <Card
        className={`border cursor-pointer transition-colors h-full ${peakUtil >= 85 ? 'border-red-200 hover:border-red-300' : peakUtil >= 70 ? 'border-amber-200 hover:border-amber-300' : 'border-gray-200 hover:border-blue-300'}`}
        onClick={() => setOpen(true)}
      >
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Utilization of the busiest station: the share of the run it spent working." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Peak Utilization</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{peakUtil.toFixed(1)}%</p>
              <p className="text-xs text-gray-400 mt-1">{bottleneck ? bottleneck.station_name : ''}</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50"><Activity className="h-4 w-4 text-blue-500" /></div>
          </div>
          {spark && <Sparkline values={spark} color="var(--ls-crim)" label="Busiest station, % busy" />}
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-red-50 to-orange-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center"><Activity className="h-5 w-5 text-red-500" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Station Utilization Ranking</h2>
                  <p className="text-xs text-gray-400 mt-0.5">All stations sorted by utilization · highest first</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Peak</p><p className="text-sm font-bold text-red-600">{peakUtil.toFixed(1)}%</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Top Station</p><p className="text-sm font-bold text-gray-800">{bottleneck?.station_name ?? '—'}</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations</p><p className="text-sm font-bold text-gray-800">{stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-44 text-center">Utilization</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">%</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-red-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => {
                const color = utilColor(s.station_utilization)
                return (
                  <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-red-50/40' : 'hover:bg-gray-50'}`}>
                    <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                    <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                    <div className="w-44 h-2.5 bg-gray-100 rounded-full overflow-hidden shrink-0">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(s.station_utilization, 100)}%`, background: color }} />
                    </div>
                    <span className="text-sm font-bold tabular-nums w-20 text-right" style={{ color }}>{s.station_utilization.toFixed(1)}%</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Avg Utilization modal card ──────────────────────────────────────────────

function AvgUtilCard({ avgUtil, stats, spark }: { avgUtil: number; stats: StationStat[]; spark?: number[] }) {
  const [open, setOpen] = useState(false)
  const sorted = [...stats].sort((a, b) => b.operator_utilization - a.operator_utilization)

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Average utilization across all stations: the share of the run a station spent working." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Station Util.</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{avgUtil.toFixed(1)}%</p>
              <p className="text-xs text-gray-400 mt-1">average across stations</p>
            </div>
            <svg viewBox="0 0 44 44" className="h-9 w-9 shrink-0" aria-hidden>
              <circle cx="22" cy="22" r="17" fill="none" stroke="var(--ls-chip)" strokeWidth="6" />
              <circle cx="22" cy="22" r="17" fill="none" stroke={utilColor(avgUtil)} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(Math.min(100, Math.max(avgUtil, 1.5)) / 100) * 106.8} 106.8`} transform="rotate(-90 22 22)" />
            </svg>
          </div>
          {spark && <Sparkline values={spark} color="var(--ls-accent)" label="Average station utilization, %" />}
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center"><Target className="h-5 w-5 text-blue-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Station & Operator Utilization</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Per-station breakdown · sorted by operator utilization</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Avg Station</p><p className="text-sm font-bold text-blue-600">{avgUtil.toFixed(1)}%</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations</p><p className="text-sm font-bold text-gray-800">{stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-24 text-right">Station%</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-24 text-right">Operator%</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => {
                const sColor = utilColor(s.station_utilization)
                return (
                  <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-blue-50/40' : 'hover:bg-gray-50'}`}>
                    <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                    <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                    <span className="text-sm font-bold tabular-nums w-24 text-right" style={{ color: sColor }}>{s.station_utilization.toFixed(1)}%</span>
                    <span className="text-sm font-bold text-blue-500 tabular-nums w-24 text-right">{s.operator_utilization.toFixed(1)}%</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Statistical analysis card ────────────────────────────────────────────────

// One stacked bar for a set of percentages (adding up to 100).
function StateBar({ parts }: { parts: { value: number; color: string; label: string }[] }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
      {parts.map((p) => p.value > 0 && (
        <div key={p.label} style={{ width: `${p.value}%`, background: p.color }} data-tip={`${p.label}\n${p.value.toFixed(2)}% of the time`} />
      ))}
    </div>
  )
}

// The Stations table: the five percentages only.
const STATION_COLUMNS = [
  { key: 'working', label: 'Working' },
  { key: 'setup', label: 'Setup' },
  { key: 'free', label: 'Free' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'failed', label: 'Failed' },
] as const
const BUFFER_STATES = [
  { key: 'empty', label: 'Empty', color: '#cbd5e1' },
  { key: 'occupied', label: 'Occupied', color: 'var(--ls-accent)' },
  { key: 'full', label: 'Full', color: 'var(--ls-bad)' },
] as const
const WORKER_STATES = [
  { key: 'working_pct', label: 'Working', color: 'var(--ls-ok)' },
  { key: 'free_pct', label: 'Free', color: '#cbd5e1' },
] as const

const count = (n: number | null | undefined) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1))

// The run's statistical analysis in one place — the same numbers the Canvas
// panels show: every working station (Working / Free / Setup / Blocked /
// Failed, parts), Buffer (Empty / Occupied / Full), Worker (Working / Free)
// and the parts the Starts delivered and the line's ends collected.
function StatisticalAnalysisCard({ result }: { result: RunDetail['result'] }) {
  const [open, setOpen] = useState(false)
  const stations = Object.entries((result?.station_states ?? {}) as Record<string, StationStateStat>)
  const buffers = Object.entries((result?.buffer_states ?? {}) as Record<string, BufferStateStat>)
  const workers = Object.entries(result?.worker_pool_stats ?? {})
    .flatMap(([controller, p]) => (p.workers ?? []).map((w) => ({ controller, w })))
  const flow = result?.parts_flow as PartsFlow | undefined
  const avgWorking = stations.length > 0 ? stations.reduce((a, [, s]) => a + s.working, 0) / stations.length : null

  const delivered = Object.entries(flow?.delivered ?? {}).map(([start, byProduct]) => ({ name: start || 'Start', byProduct }))
  const collected: Record<string, number> = {}
  for (const byRoute of Object.values(flow?.collected ?? {})) {
    for (const names of Object.values(byRoute)) {
      for (const [name, n] of Object.entries(names)) collected[name] = (collected[name] ?? 0) + n
    }
  }
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  const perProduct = (o: Record<string, number>) =>
    Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => `${p} ${count(n)}`).join(' · ')

  const th = 'text-[10px] font-bold text-gray-400 uppercase tracking-wider py-2 px-3 text-right whitespace-nowrap'
  const thLeft = 'text-[10px] font-bold text-gray-400 uppercase tracking-wider py-2 px-3 text-left whitespace-nowrap'
  const td = 'py-2.5 px-3 text-right tabular-nums text-sm text-gray-700 whitespace-nowrap'
  const section = (title: string, sub: string) => (
    <div className="px-6 pt-5 pb-2">
      <h3 className="text-sm font-bold text-gray-900">{title}</h3>
      <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  )

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Averages and spread of the run measures across stations and jobs." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Statistical Analysis</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{avgWorking == null ? '—' : `${avgWorking.toFixed(1)}%`}</p>
              <p className="text-xs text-gray-400 mt-1">{avgWorking == null ? 'run again to see it' : 'avg working, across stations'}</p>
            </div>
            <div className="p-2 rounded-lg bg-emerald-50"><BarChart2 className="h-4 w-4 text-emerald-500" /></div>
          </div>
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[1040px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center"><BarChart2 className="h-5 w-5 text-emerald-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Statistical Analysis</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Stations, Buffers, Workers, Start and End · after the warm-up</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>

            <div className="flex-1 overflow-y-auto pb-5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-emerald-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {stations.length === 0 && buffers.length === 0 && workers.length === 0 && !flow && (
                <p className="px-6 py-8 text-sm text-gray-400">This run was made before the statistical analysis existed — run the simulation again to see it.</p>
              )}

              {stations.length > 0 && (
                <>
                  {section('Stations', '% of the operating time (shift time minus breaks and PM)')}
                  <div className="mx-6 overflow-x-auto rounded-xl border border-gray-100">
                    <table className="w-full">
                      <thead><tr className="bg-gray-50 border-b border-gray-100">
                        <th className={thLeft}>Station</th>
                        {STATION_COLUMNS.map((st) => <th key={st.key} className={th}>{st.label}</th>)}
                      </tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {stations.map(([name, s]) => (
                          <tr key={name} className="hover:bg-gray-50">
                            <td className="py-2.5 px-3 text-sm font-semibold text-gray-800 whitespace-nowrap">{name}</td>
                            {STATION_COLUMNS.map((st) => <td key={st.key} className={td}>{s[st.key].toFixed(1)}%</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {buffers.length > 0 && (
                <>
                  {section('Buffers', '% of the operating time (shift time minus breaks)')}
                  <div className="mx-6 overflow-x-auto rounded-xl border border-gray-100">
                    <table className="w-full">
                      <thead><tr className="bg-gray-50 border-b border-gray-100">
                        <th className={thLeft}>Buffer</th>
                        <th className={`${thLeft} w-40`} />
                        {BUFFER_STATES.map((st) => <th key={st.key} className={th}>{st.label}</th>)}
                      </tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {buffers.map(([name, s]) => (
                          <tr key={name} className="hover:bg-gray-50">
                            <td className="py-2.5 px-3 text-sm font-semibold text-gray-800 whitespace-nowrap">{name}</td>
                            <td className="py-2.5 px-3"><StateBar parts={BUFFER_STATES.map((st) => ({ value: s[st.key], color: st.color, label: st.label }))} /></td>
                            {BUFFER_STATES.map((st) => <td key={st.key} className={td}>{s[st.key].toFixed(1)}%</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {workers.length > 0 && (
                <>
                  {section('Workers', "% of the available time (the Worker Controller's shift, minus time away) · walking counts as Free")}
                  <div className="mx-6 overflow-x-auto rounded-xl border border-gray-100">
                    <table className="w-full">
                      <thead><tr className="bg-gray-50 border-b border-gray-100">
                        <th className={thLeft}>Worker</th>
                        <th className={thLeft}>Worker Controller</th>
                        <th className={`${thLeft} w-40`} />
                        {WORKER_STATES.map((st) => <th key={st.key} className={th}>{st.label}</th>)}
                        <th className={th}>Worked</th><th className={th}>Jobs</th>
                      </tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {workers.map(({ controller, w }) => (
                          <tr key={`${controller}|${w.name}`} className="hover:bg-gray-50">
                            <td className="py-2.5 px-3 text-sm font-semibold text-gray-800 whitespace-nowrap">{w.name}</td>
                            <td className="py-2.5 px-3 text-sm text-gray-600 whitespace-nowrap">{controller}</td>
                            <td className="py-2.5 px-3"><StateBar parts={WORKER_STATES.map((st) => ({ value: w[st.key] ?? 0, color: st.color, label: st.label }))} /></td>
                            {WORKER_STATES.map((st) => <td key={st.key} className={td}>{w[st.key] == null ? '—' : `${(w[st.key] ?? 0).toFixed(1)}%`}</td>)}
                            <td className={td}>{w.worked_time.toFixed(1)} min</td>
                            <td className={td}>{w.jobs}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {flow && (
                <>
                  {section('Start and End', 'Parts delivered by each Start · parts collected at the end of the line (every End together; each Dismantle piece counts)')}
                  <div className="mx-6 overflow-x-auto rounded-xl border border-gray-100">
                    <table className="w-full">
                      <thead><tr className="bg-gray-50 border-b border-gray-100">
                        <th className={thLeft}>Box</th>
                        <th className={thLeft}>Per product</th>
                        <th className={th}>Parts</th>
                      </tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {delivered.map((d) => (
                          <tr key={`start|${d.name}`} className="hover:bg-gray-50">
                            <td className="py-2.5 px-3 text-sm font-semibold text-gray-800 whitespace-nowrap">{d.name} · delivered</td>
                            <td className="py-2.5 px-3 text-xs text-gray-600">{perProduct(d.byProduct)}</td>
                            <td className={td}>{count(sum(d.byProduct))}</td>
                          </tr>
                        ))}
                        <tr className="hover:bg-gray-50">
                          <td className="py-2.5 px-3 text-sm font-semibold text-gray-800 whitespace-nowrap">End · collected</td>
                          <td className="py-2.5 px-3 text-xs text-gray-600">{perProduct(collected) || '—'}</td>
                          <td className={td}>{count(sum(collected))}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Setup time modal card ────────────────────────────────────────────────────

function AvgSetupCard({ stats }: { stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const totalSetup = stats.reduce((sum, s) => sum + (s.total_setup_time ?? 0), 0)
  const sorted = [...stats].sort((a, b) => (b.total_setup_time ?? 0) - (a.total_setup_time ?? 0))

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-purple-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Time stations spent on setup between jobs." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Setup Time</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{totalSetup.toFixed(1)} min</p>
              <p className="text-xs text-gray-400 mt-1">total across stations</p>
            </div>
            <div className="p-2 rounded-lg bg-purple-50"><Settings className="h-4 w-4 text-purple-500" /></div>
          </div>
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-indigo-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-100 flex items-center justify-center"><Settings className="h-5 w-5 text-purple-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Setup / Changeover Time</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Per-station breakdown · sorted by setup time</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Total Setup</p><p className="text-sm font-bold text-purple-600">{totalSetup.toFixed(1)} min</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations</p><p className="text-sm font-bold text-gray-800">{stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-28 text-right">Setup Time (min)</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-purple-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-purple-50/40' : 'hover:bg-gray-50'}`}>
                  <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                  <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                  <span className="text-sm font-bold text-purple-600 tabular-nums w-28 text-right">{(s.total_setup_time ?? 0).toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Cycle time modal card ─────────────────────────────────────────────────────

function AvgCycleTimeCard({ stats }: { stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const withCt = stats.filter(s => (s.max_cycle_time ?? 0) > 0)
  const worstCycleTime = withCt.length
    ? Math.max(...withCt.map(s => s.max_cycle_time ?? 0))
    : 0
  const sorted = [...stats].sort((a, b) => (b.max_cycle_time ?? 0) - (a.max_cycle_time ?? 0))

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-teal-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="The longest average time any station took to process one job." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Max Cycle Time</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{worstCycleTime.toFixed(1)} min</p>
              <p className="text-xs text-gray-400 mt-1">worst-case, arrival to completion, across stations</p>
            </div>
            <div className="p-2 rounded-lg bg-teal-50"><Timer className="h-4 w-4 text-teal-500" /></div>
          </div>
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-teal-50 to-cyan-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-teal-100 flex items-center justify-center"><Timer className="h-5 w-5 text-teal-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Cycle Time per Station</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Per-station breakdown · sorted by cycle time · worst-case (max) time from a job's arrival at the station to its completion there</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Max Cycle Time</p><p className="text-sm font-bold text-teal-600">{worstCycleTime.toFixed(1)} min</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations</p><p className="text-sm font-bold text-gray-800">{stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-32 text-right">Cycle Time (min)</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-teal-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-teal-50/40' : 'hover:bg-gray-50'}`}>
                  <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                  <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                  <span className="text-sm font-bold text-teal-600 tabular-nums w-32 text-right">{(s.max_cycle_time ?? 0).toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Buffer blocked modal card ────────────────────────────────────────────────

function AvgBufferBlockedCard({ stats }: { stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const avgBlocked = stats.length
    ? stats.reduce((sum, s) => sum + (s.buffer_blocked_ratio ?? 0), 0) / stats.length
    : 0
  const sorted = [...stats].sort((a, b) => (b.buffer_blocked_ratio ?? 0) - (a.buffer_blocked_ratio ?? 0))

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-rose-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Share of time a station was blocked: it had finished a job but could not pass it on." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Buffer Blocked</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{avgBlocked.toFixed(1)}%</p>
              <p className="text-xs text-gray-400 mt-1">stuck waiting on a full downstream buffer</p>
            </div>
            <div className="p-2 rounded-lg bg-rose-50"><Layers className="h-4 w-4 text-rose-500" /></div>
          </div>
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[680px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-rose-50 to-red-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-rose-100 flex items-center justify-center"><Layers className="h-5 w-5 text-rose-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Buffer-Caused Blocking</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Per-station breakdown · sorted by blocked % · a station is "blocked" here when it finished a job but the next station's buffer was full</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Avg Blocked</p><p className="text-sm font-bold text-rose-600">{avgBlocked.toFixed(1)}%</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations</p><p className="text-sm font-bold text-gray-800">{stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Blocked%</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-28 text-right">Blocked (min)</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Next Buf.</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">Order</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-rose-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-rose-50/40' : 'hover:bg-gray-50'}`}>
                  <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                  <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                  <span className="text-sm font-bold text-rose-600 tabular-nums w-20 text-right">{(s.buffer_blocked_ratio ?? 0).toFixed(1)}%</span>
                  <span className="text-sm text-gray-600 tabular-nums w-28 text-right">{(s.buffer_blocked_time ?? 0).toFixed(1)}</span>
                  <span className="text-sm text-gray-600 tabular-nums w-20 text-right">{s.buffer_capacity ? s.buffer_capacity : 'Unlimited'}</span>
                  <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.buffer_discipline || 'FIFO'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Bottleneck modal card ────────────────────────────────────────────────────

function BottleneckCard({ bottleneck, stats }: { bottleneck: StationStat | null; stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const sorted = [...stats].sort((a, b) => b.station_utilization - a.station_utilization)
  // More than one station can cross the bottleneck threshold at once — the
  // headline card names the single busiest (kpi_bottleneck_station), but
  // when others are also at/above it, say so instead of implying there's
  // only ever one. Full ranked list is still one click away in the modal.
  const otherBottlenecks = sorted.filter(
    s => s.station_utilization >= 85 && s.station_name !== bottleneck?.station_name
  )

  return (
    <div className="relative h-full">
      <Card
        className={`border cursor-pointer transition-colors h-full ${bottleneck && bottleneck.station_utilization >= 85 ? 'border-red-200 hover:border-red-300' : 'border-gray-200 hover:border-blue-300'}`}
        onClick={() => setOpen(true)}
      >
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p data-tip="The busiest station. It sets how fast the whole line can go." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Bottleneck Station</p>
              <p
                className={`font-bold text-gray-900 mt-1 leading-tight break-words ${
                  (bottleneck?.station_name?.length ?? 0) > 14 ? 'text-lg' : 'text-2xl'
                }`}
              >
                {bottleneck?.station_name ?? '—'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {bottleneck ? `${bottleneck.station_utilization.toFixed(1)}% util.` : 'no bottleneck'}
                {otherBottlenecks.length > 0 && ` · +${otherBottlenecks.length} more`}
              </p>
            </div>
            <i className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: bottleneck ? utilColor(bottleneck.station_utilization) : 'var(--ls-mute)' }} />
          </div>
          {bottleneck && (
            <div className="mt-3 h-2 overflow-hidden rounded-md bg-ls-chip">
              <i
                className="block h-full rounded-md"
                style={{ width: `${Math.min(100, bottleneck.station_utilization)}%`, background: `linear-gradient(90deg, ${utilColor(bottleneck.station_utilization)}, color-mix(in srgb, ${utilColor(bottleneck.station_utilization)} 55%, white))` }}
              />
            </div>
          )}
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-red-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center"><Zap className="h-5 w-5 text-orange-500" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">All Stations by Utilization</h2>
                  <p className="text-xs text-gray-400 mt-0.5">{sorted.length} stations · sorted highest to lowest</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Bottleneck</p><p className="text-sm font-bold text-red-600">{bottleneck?.station_name ?? '—'}</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Peak Util</p><p className="text-sm font-bold text-gray-800">{bottleneck?.station_utilization.toFixed(1)}%</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Failures</p><p className="text-sm font-bold text-gray-800">{bottleneck?.failure_breakdowns ?? 0}</p></div>
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations ≥85%</p><p className="text-sm font-bold text-gray-800">{sorted.filter(s => s.station_utilization >= 85).length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-44 text-center">Utilization</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">Failures</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">Jobs</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-orange-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => {
                const color = utilColor(s.station_utilization)
                return (
                  <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-orange-50/40' : 'hover:bg-gray-50'}`}>
                    <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                    <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                    <div className="w-44 h-2.5 bg-gray-100 rounded-full overflow-hidden shrink-0">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(s.station_utilization, 100)}%`, background: color }} />
                    </div>
                    <span className="text-sm font-bold tabular-nums w-16 text-right" style={{ color }}>{s.station_utilization.toFixed(1)}%</span>
                    <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.failure_breakdowns}</span>
                    <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.completed_jobs}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Throughput popup card ────────────────────────────────────────────────────

type ThroughputSort = 'throughput_desc' | 'throughput_asc' | 'name_asc' | 'name_desc'

function ThroughputCard({ value, sub, stats, spark }: { value: string; sub: string; stats: StationStat[]; spark?: number[] }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<ThroughputSort>('throughput_desc')

  // maxTp/total/Top Station always reflect ALL stations regardless of the
  // search filter below — the summary strip describes the whole run, not
  // just the currently-filtered view.
  const byThroughputDesc = [...stats].sort((a, b) => b.throughput - a.throughput)
  const maxTp = byThroughputDesc[0]?.throughput || 1
  const total = stats.reduce((s, x) => s + x.throughput, 0)

  const filtered = search.trim()
    ? stats.filter(s => s.station_name.toLowerCase().includes(search.trim().toLowerCase()))
    : stats
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'throughput_asc': return a.throughput - b.throughput
      case 'name_asc': return a.station_name.localeCompare(b.station_name)
      case 'name_desc': return b.station_name.localeCompare(a.station_name)
      default: return b.throughput - a.throughput
    }
  })

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Jobs finished per hour of simulated time. Click for the per-station numbers." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Throughput</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{value}</p>
              <p className="text-xs text-gray-400 mt-1">{sub}</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50">
              <TrendingUp className="h-4 w-4 text-blue-500" />
            </div>
          </div>
          {spark && <Sparkline values={spark} color="var(--ls-purple)" label="Jobs finished per period" />}
        </CardContent>
      </Card>

      {/* Full-page modal */}
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div className="relative bg-white rounded-2xl shadow-2xl w-[720px] max-h-[80vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center">
                  <TrendingUp className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Throughput per Station</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Jobs completed per hour · sorted by highest</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Summary strip */}
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Total</p>
                <p className="text-sm font-bold text-gray-800">{total.toFixed(4)} /hr</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations</p>
                <p className="text-sm font-bold text-gray-800">{stats.length}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Top Station</p>
                <p className="text-sm font-bold text-blue-600">{byThroughputDesc[0]?.station_name ?? '—'}</p>
              </div>
            </div>

            {/* Search + sort */}
            <div className="flex items-center gap-2 px-6 py-2.5 border-b border-gray-100">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by station…"
                  className="w-full pl-8 pr-3 py-1.5 text-sm text-gray-800 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as ThroughputSort)}
                className="h-8 text-sm text-gray-700 bg-white border border-gray-200 rounded-lg px-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="throughput_desc">Throughput: high to low</option>
                <option value="throughput_asc">Throughput: low to high</option>
                <option value="name_asc">Station: A to Z</option>
                <option value="name_desc">Station: Z to A</option>
              </select>
              {(search.trim() || sortBy !== 'throughput_desc') && (
                <button
                  onClick={() => { setSearch(''); setSortBy('throughput_desc') }}
                  className="h-8 text-sm font-medium px-3 rounded-lg text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Clear
                </button>
              )}
              <span className="text-xs text-gray-400 ml-auto">{sorted.length} of {stats.length} stations</span>
            </div>

            {/* Column headers */}
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase w-6">#</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-24 text-center">Rate vs Best</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-14 text-right">% of Max</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Jobs/month</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Jobs/day</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-24 text-right">Jobs/hr</span>
            </div>

            {/* Rows */}
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {sorted.map((s, i) => {
                const pct = Math.min(100, (s.throughput / maxTp) * 100)
                return (
                  <div
                    key={s.station_name}
                    className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-blue-50/40' : 'hover:bg-gray-50'}`}
                  >
                    <span className="text-xs font-bold text-gray-300 w-6 tabular-nums shrink-0">{i + 1}</span>
                    <span className="text-sm text-gray-800 font-medium flex-1">{s.station_name}</span>
                    <div className="w-24 h-2.5 bg-gray-100 rounded-full overflow-hidden shrink-0">
                      <div
                        className="h-full rounded-full bg-blue-400 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold tabular-nums w-14 text-right text-gray-500">
                      {pct.toFixed(0)}%
                    </span>
                    <span className="text-sm font-bold text-gray-600 tabular-nums w-20 text-right">
                      {(s.throughput * 24 * 30).toFixed(1)}
                    </span>
                    <span className="text-sm font-bold text-gray-600 tabular-nums w-20 text-right">
                      {(s.throughput * 24).toFixed(2)}
                    </span>
                    <span className="text-sm font-bold text-blue-700 tabular-nums w-24 text-right">
                      {s.throughput.toFixed(4)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Stations at Risk popup card ─────────────────────────────────────────────

function AtRiskCard({ count, stats }: { count: number; stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const riskStations = stats
    .filter(s => s.station_utilization >= 80)
    .sort((a, b) => b.station_utilization - a.station_utilization)
  const accent = count > 0 ? 'border-amber-200' : 'border-gray-200'

  return (
    <div className="relative h-full">
      <Card
        className={`border ${accent} h-full ${count > 0 ? 'cursor-pointer hover:border-amber-300' : ''} transition-colors`}
        onClick={() => count > 0 && setOpen(true)}
      >
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Stations working 80% of the run or more, so close to their limit." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Stations at Risk</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{count}</p>
              <p className="text-xs text-gray-400 mt-1">≥ 80% utilization</p>
            </div>
            <div className={`p-2 rounded-lg ${count > 0 ? 'bg-amber-50' : 'bg-blue-50'}`}>
              <AlertCircle className={`h-4 w-4 ${count > 0 ? 'text-amber-500' : 'text-blue-500'}`} />
            </div>
          </div>
        </CardContent>
      </Card>

      {open && riskStations.length > 0 && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-orange-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center">
                  <AlertCircle className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Stations at Risk</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Stations with utilization ≥ 80% · sorted by highest</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Summary strip */}
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">At Risk</p>
                <p className="text-sm font-bold text-amber-600">{riskStations.length} stations</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Highest Util</p>
                <p className="text-sm font-bold text-red-600">{riskStations[0]?.station_utilization.toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Top Station</p>
                <p className="text-sm font-bold text-gray-800">{riskStations[0]?.station_name ?? '—'}</p>
              </div>
            </div>
            {/* Column headers */}
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-40 text-center">Utilization</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">Failures</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">Jobs</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Rework%</span>
            </div>
            {/* Rows */}
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-amber-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {riskStations.map((s, i) => {
                const isBottleneck = s.station_utilization >= 85
                const barColor = isBottleneck ? 'var(--ls-bad)' : 'var(--ls-warn)'
                return (
                  <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-amber-50/40' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: barColor }} />
                      <span className="text-sm text-gray-800 font-medium truncate">{s.station_name}</span>
                    </div>
                    <div className="flex items-center gap-2 w-40 shrink-0">
                      <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(s.station_utilization, 100)}%`, background: barColor }} />
                      </div>
                      <span className="text-sm font-bold tabular-nums w-12 text-right" style={{ color: barColor }}>{s.station_utilization.toFixed(1)}%</span>
                    </div>
                    <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.failure_breakdowns}</span>
                    <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.completed_jobs}</span>
                    <span className="text-sm text-gray-600 tabular-nums w-20 text-right">{s.rework_percentage.toFixed(1)}%</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Total Failures popup card ────────────────────────────────────────────────

function TotalFailuresCard({ total, rework, stats }: { total: number; rework: number; stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const failedStations = stats
    .filter(s => s.failure_breakdowns > 0)
    .sort((a, b) => b.failure_breakdowns - a.failure_breakdowns)
  const maxFailures = failedStations[0]?.failure_breakdowns || 1

  return (
    <div className="relative h-full">
      <Card
        className={`border h-full transition-colors ${total > 0 ? 'border-red-100 cursor-pointer hover:border-red-300' : 'border-gray-200'}`}
        onClick={() => total > 0 && setOpen(true)}
      >
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Machine breakdowns across all stations. Avg rework is the share of jobs that had to be redone." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Total Failures</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{total}</p>
              <p className="text-xs text-gray-400 mt-1">{rework.toFixed(1)}% avg rework</p>
            </div>
            <div className={`p-2 rounded-lg ${total > 0 ? 'bg-red-50' : 'bg-blue-50'}`}>
              <AlertTriangle className={`h-4 w-4 ${total > 0 ? 'text-red-400' : 'text-blue-500'}`} />
            </div>
          </div>
        </CardContent>
      </Card>

      {open && failedStations.length > 0 && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-red-50 to-rose-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-red-100 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-red-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Failure Breakdown</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Stations with failures · sorted by highest</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Summary strip */}
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Total Failures</p>
                <p className="text-sm font-bold text-red-600">{total}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Avg Rework</p>
                <p className="text-sm font-bold text-gray-800">{rework.toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Most Failures</p>
                <p className="text-sm font-bold text-gray-800">{failedStations[0]?.station_name ?? '—'}</p>
              </div>
            </div>
            {/* Column headers */}
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-40 text-center">Failures</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">PM Stops</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-16 text-right">Util%</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">Rework%</span>
            </div>
            {/* Rows */}
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-red-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {failedStations.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-red-50/40' : 'hover:bg-gray-50'}`}>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
                    <span className="text-sm text-gray-800 font-medium truncate">{s.station_name}</span>
                  </div>
                  <div className="flex items-center gap-2 w-40 shrink-0">
                    <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-red-400" style={{ width: `${(s.failure_breakdowns / maxFailures) * 100}%` }} />
                    </div>
                    <span className="text-sm font-bold text-red-600 tabular-nums w-12 text-right">{s.failure_breakdowns}</span>
                  </div>
                  <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.pm_breakdowns}</span>
                  <span className="text-sm text-gray-600 tabular-nums w-16 text-right">{s.station_utilization.toFixed(1)}%</span>
                  <span className="text-sm text-gray-600 tabular-nums w-20 text-right">{s.rework_percentage.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── MTBF / Availability shared helpers ───────────────────────────────────────
// A station with capacity>1 has several independent parallel machines (see
// MachineGroup in backend/engine/machine.py) — one failing only takes out
// that one machine, not the whole station. failure_breakdowns is the POOLED
// total across all of them, so simTime/failure_breakdowns (the old formula)
// treats every failure as if it stopped the entire station, which is only
// true at capacity=1 and understates MTBF/Availability as capacity grows.
// failure_counts_per_machine (when present) gives each sub-machine's own
// count, so MTBF/Availability can be computed per machine first, then
// averaged — old runs without this field (or capacity=1, where the two
// approaches are mathematically identical) fall back to the pooled formula.

/** Per-sub-machine MTBF values (minutes), one per machine that had >=1 failure. */
function perMachineMtbf(s: StationStat, simTime: number): number[] {
  const perMachine = s.failure_counts_per_machine
  if (perMachine && perMachine.length > 0) {
    return perMachine.filter(c => c > 0).map(c => simTime / c)
  }
  // Fallback: old runs without per-sub-machine data, or capacity=1 (the two
  // approaches are identical in that case since there's only one machine).
  return s.failure_breakdowns > 0 ? [simTime / s.failure_breakdowns] : []
}

/** Station-level MTBF — average of that station's own per-machine MTBF values. */
function stationMtbf(s: StationStat, simTime: number): number | null {
  const values = perMachineMtbf(s, simTime)
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null
}

/** Station-level Availability (%) — average of each machine's own Availability
 * fraction (not derived from the averaged MTBF — see MtbfCard/AvailabilityCard
 * comments below for why that distinction matters). */
function stationAvailability(s: StationStat, simTime: number, mttr: number): number | null {
  const mtbfValues = perMachineMtbf(s, simTime)
  if (mtbfValues.length === 0) return null
  const availabilities = mtbfValues.map(mtbf => mtbf / (mtbf + mttr))
  return (availabilities.reduce((sum, a) => sum + a, 0) / availabilities.length) * 100
}

/**
 * Configured (theoretical, pre-run) MTBF — what the station's reliability
 * settings predict on AVERAGE across many runs, as opposed to the Observed
 * MTBF above (what actually happened in THIS one run's random failures).
 *
 * Prefers the station's stored `MTBF` (minutes, uncapped) — written by the
 * Process Flow tab's Availability%+MTTR fields (ScenarioManager.tsx) and
 * what backend/engine/machine.py now reads directly. Falls back to the
 * legacy `1440 / Failure rate` estimate for scenarios saved before the
 * MTBF field existed — failureRate there is the RAW DECIMAL stored on
 * stations_data['Failure rate'] (e.g. 1 = 100%, 0.9 = 90%, matching
 * backend/engine/machine.py's 0<=failure_rate<=1 validation), NOT a 0-100
 * percentage.
 *
 * null when neither MTBF nor Failure Rate is set (station configured to
 * never fail — "no configured MTBF" is the honest answer, not an
 * infinite/fake one).
 */
function configuredMtbf(failureRate: number | undefined, mtbf: number | undefined): number | null {
  if (mtbf != null && mtbf > 0) return mtbf
  const rate = failureRate ?? 0
  return rate > 0 ? 1440 / rate : null
}

/** Configured (theoretical, pre-run) Availability (%) from configuredMtbf
 * (MTBF field if present, else legacy Failure Rate estimate) + MTTR. */
function configuredAvailability(failureRate: number | undefined, mttr: number, mtbf: number | undefined): number | null {
  const resolvedMtbf = configuredMtbf(failureRate, mtbf)
  if (resolvedMtbf == null) return null
  if (mttr <= 0) return 100
  return (resolvedMtbf / (resolvedMtbf + mttr)) * 100
}

// ─── MTBF (Mean Time Between Failures) card ───────────────────────────────────
// Shows BOTH numbers side by side, since they answer different questions and
// were easy to confuse when only one was visible at a time:
//   Observed   — minutes of run time / actual breakdown count THIS run had.
//                A station with 0 failures has no observed MTBF (division
//                by zero), shown as "—" rather than treated as "never fails".
//   Configured — what the station's Failure Rate setting predicts on
//                AVERAGE across many runs (configuredMtbf above). Any ONE
//                run's Observed value can reasonably land far from this —
//                failures are a random process, not a fixed countdown — so
//                showing both together is the point, not a bug to reconcile.

function MtbfCard({
  simTime, stats, stationsData,
}: { simTime: number; stats: StationStat[]; stationsData: Record<string, { 'Failure rate'?: number; MTBF?: number }> }) {
  const [open, setOpen] = useState(false)
  const withFailures = stats.filter(s => s.failure_breakdowns > 0)
  const perStationMtbf = withFailures.map(s => ({
    ...s,
    mtbf: stationMtbf(s, simTime) ?? 0,
    configured: configuredMtbf(stationsData[s.station_name]?.['Failure rate'], stationsData[s.station_name]?.['MTBF']),
  })).sort((a, b) => a.mtbf - b.mtbf)
  // Configured MTBF doesn't depend on whether this run happened to fail —
  // averaged across every station that HAS a Failure Rate set, not just
  // the ones that failed this particular run.
  const configuredValues = stats
    .map(s => configuredMtbf(stationsData[s.station_name]?.['Failure rate'], stationsData[s.station_name]?.['MTBF']))
    .filter((v): v is number => v != null)
  const avgConfiguredMtbf = configuredValues.length > 0
    ? configuredValues.reduce((sum, v) => sum + v, 0) / configuredValues.length
    : null

  return (
    <div className="relative h-full">
      <Card
        className={`border h-full transition-colors ${withFailures.length > 0 ? 'border-gray-200 cursor-pointer hover:border-amber-300' : 'border-gray-200'}`}
        onClick={() => withFailures.length > 0 && setOpen(true)}
      >
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Mean time between failures: how long a station runs, on average, between breakdowns." className="text-xs text-gray-500 uppercase tracking-wide font-medium">MTBF</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">
                {avgConfiguredMtbf != null ? `${avgConfiguredMtbf.toFixed(0)} min` : '—'}
              </p>
              <p className="text-xs text-gray-400 mt-1">configured</p>
            </div>
            <div className="p-2 rounded-lg bg-amber-50"><Timer className="h-4 w-4 text-amber-500" /></div>
          </div>
        </CardContent>
      </Card>

      {open && perStationMtbf.length > 0 && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[720px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-yellow-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center"><Timer className="h-5 w-5 text-amber-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Mean Time Between Failures</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Configured MTBF per station</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              {avgConfiguredMtbf != null && (
                <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Avg Configured MTBF</p><p className="text-sm font-bold text-gray-600">{avgConfiguredMtbf.toFixed(0)} min</p></div>
              )}
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations w/ Failures</p><p className="text-sm font-bold text-gray-800">{withFailures.length} / {stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-24 text-right">Failures</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-28 text-right">Configured (min)</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-amber-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {perStationMtbf.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-amber-50/40' : 'hover:bg-gray-50'}`}>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                    <span className="text-sm text-gray-800 font-medium truncate">{s.station_name}</span>
                  </div>
                  <span className="text-sm text-gray-600 tabular-nums w-24 text-right">{s.failure_breakdowns}</span>
                  <span className="text-sm text-gray-500 tabular-nums w-28 text-right">{s.configured != null ? s.configured.toFixed(0) : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Availability card ─────────────────────────────────────────────────────────
// Shows BOTH numbers, same reasoning as MtbfCard above:
//   Observed   — MTBF/(MTBF+MTTR) using THIS run's observed MTBF. A station
//                with 0 failures this run has no observed MTBF, so no
//                Observed Availability either — "—", not a false 100%.
//   Configured — MTBF/(MTBF+MTTR) using the Failure-Rate-predicted MTBF
//                (configuredAvailability above) — what ScenarioManager.tsx's
//                own Availability field already shows before running.

function AvailabilityCard({
  simTime, stats, stationsData,
}: { simTime: number; stats: StationStat[]; stationsData: Record<string, { 'Repair Time'?: number; 'Failure rate'?: number; MTBF?: number }> }) {
  const [open, setOpen] = useState(false)
  const withFailures = stats.filter(s => s.failure_breakdowns > 0)
  const perStation = withFailures.map(s => {
    const mttr = stationsData[s.station_name]?.['Repair Time'] ?? 10
    const mtbf = stationMtbf(s, simTime) ?? 0
    const availability = stationAvailability(s, simTime, mttr) ?? 0
    const configured = configuredAvailability(stationsData[s.station_name]?.['Failure rate'], mttr, stationsData[s.station_name]?.['MTBF'])
    return { ...s, mtbf, mttr, availability, configured }
  }).sort((a, b) => a.availability - b.availability)
  // Configured Availability doesn't depend on whether this run happened to
  // fail — averaged across every station that HAS a Failure Rate set, not
  // just the ones that failed this particular run.
  const configuredValues = stats
    .map(s => configuredAvailability(
      stationsData[s.station_name]?.['Failure rate'],
      stationsData[s.station_name]?.['Repair Time'] ?? 10,
      stationsData[s.station_name]?.['MTBF'],
    ))
    .filter((v): v is number => v != null)
  const avgConfiguredAvailability = configuredValues.length > 0
    ? configuredValues.reduce((sum, v) => sum + v, 0) / configuredValues.length
    : null

  return (
    <div className="relative h-full">
      <Card
        className={`border h-full transition-colors ${perStation.length > 0 ? 'border-gray-200 cursor-pointer hover:border-emerald-300' : 'border-gray-200'}`}
        onClick={() => perStation.length > 0 && setOpen(true)}
      >
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="Share of the time stations were not broken down." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Availability</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">
                {avgConfiguredAvailability != null ? `${avgConfiguredAvailability.toFixed(2)}%` : '—'}
              </p>
              <p className="text-xs text-gray-400 mt-1">configured</p>
            </div>
            <div className="p-2 rounded-lg bg-emerald-50"><CheckCircle className="h-4 w-4 text-emerald-500" /></div>
          </div>
        </CardContent>
      </Card>

      {open && perStation.length > 0 && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[760px] max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-green-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center"><CheckCircle className="h-5 w-5 text-emerald-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Station Availability</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Configured Availability per station</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              {avgConfiguredAvailability != null && (
                <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Avg Configured</p><p className="text-sm font-bold text-gray-600">{avgConfiguredAvailability.toFixed(2)}%</p></div>
              )}
              <div><p className="text-[10px] text-gray-400 uppercase tracking-widest">Stations w/ Failures</p><p className="text-sm font-bold text-gray-800">{perStation.length} / {stats.length}</p></div>
            </div>
            <div className="flex items-center gap-3 px-6 py-2 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase flex-1">Station</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-20 text-right">MTTR (min)</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase w-24 text-right">Configured</span>
            </div>
            <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-emerald-200 [&::-webkit-scrollbar-thumb]:rounded-full">
              {perStation.map((s, i) => (
                <div key={s.station_name} className={`flex items-center gap-3 px-6 py-3.5 border-b border-gray-50 last:border-0 ${i === 0 ? 'bg-emerald-50/40' : 'hover:bg-gray-50'}`}>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                    <span className="text-sm text-gray-800 font-medium truncate">{s.station_name}</span>
                  </div>
                  <span className="text-sm text-gray-600 tabular-nums w-20 text-right">{s.mttr.toFixed(0)}</span>
                  <span className="text-sm text-gray-500 tabular-nums w-24 text-right">{s.configured != null ? `${s.configured.toFixed(2)}%` : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sim Duration modal card ──────────────────────────────────────────────────

function SimDurationCard({
  simDays, simTime, simCfg,
}: {
  simDays: string
  simTime: number
  simCfg: SimConfigOverride
}) {
  const [open, setOpen] = useState(false)

  const totalMin = simCfg.SIM_TIME ?? simTime
  const shiftMin = simCfg.SHIFT_DURATION ?? 480
  const shiftsPerDay = Math.floor(1440 / shiftMin)
  const workMinPerDay = shiftMin * shiftsPerDay
  const calDays = workMinPerDay > 0 ? (totalMin / workMinPerDay).toFixed(1) : '—'
  const totalHours = (totalMin / 60).toFixed(1)

  const rows = [
    { label: 'Total Sim Time', value: `${totalMin.toLocaleString()} min` },
    { label: 'Total Hours', value: `${totalHours} hrs` },
    { label: 'Calendar Days', value: `${calDays} days` },
    { label: 'Shift Duration', value: `${shiftMin} min (${(shiftMin/60).toFixed(1)} hrs)` },
    { label: 'Shifts per Day', value: `${shiftsPerDay}` },
    { label: 'Work Min / Day', value: `${workMinPerDay} min` },
    { label: 'Actual Sim Time', value: simTime > 0 ? `${simTime.toFixed(0)} min` : '—' },
  ]

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p data-tip="How long the simulation ran, in minutes, hours and calendar days." className="text-xs text-gray-500 uppercase tracking-wide font-medium">Sim Duration</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{simDays} days</p>
              <p className="text-xs text-gray-400 mt-1">{simTime.toFixed(0)} min</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50">
              <Clock className="h-4 w-4 text-blue-500" />
            </div>
          </div>
        </CardContent>
      </Card>

      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[480px] overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center">
                  <Clock className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Simulation Duration</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Time & shift configuration breakdown</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Summary strip */}
            <div className="flex items-center gap-6 px-6 py-3 bg-gray-50 border-b border-gray-100">
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Total Minutes</p>
                <p className="text-sm font-bold text-gray-800">{totalMin.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Hours</p>
                <p className="text-sm font-bold text-gray-800">{totalHours}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-widest">Calendar Days</p>
                <p className="text-sm font-bold text-blue-600">{calDays}</p>
              </div>
            </div>

            {/* Breakdown rows */}
            <div className="px-6 py-4 space-y-3">
              {rows.map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <span className="text-sm text-gray-500">{label}</span>
                  <span className="text-sm font-bold text-gray-800 tabular-nums">{value}</span>
                </div>
              ))}
            </div>

            {/* Explanation */}
            <div className="mx-6 mb-5 px-4 py-3 bg-blue-50 rounded-xl">
              <p className="text-xs text-blue-700 leading-relaxed">
                The simulation runs for <strong>{totalMin.toLocaleString()} minutes</strong> of simulated factory time,
                split into <strong>{shiftMin}-minute shifts</strong>. This covers approximately <strong>{calDays} working days</strong>.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Job Trace table ──────────────────────────────────────────────────────────

function JobTraceTable({
  result, isExpanded, onExpandToggle,
}: { result: Record<string, unknown>; isExpanded?: boolean; onExpandToggle?: () => void }) {
  const [search, setSearch] = useState('')
  const [stationFilter, setStationFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [delayedOnly, setDelayedOnly] = useState(false)
  const rawLog = result?.completion_log as Record<string, unknown[]> | undefined
  const allRows = rawLog ? parseJobTrace(rawLog) : []
  const expanded = isExpanded ?? false

  const stations = Array.from(new Set(allRows.map(r => r.station))).sort()
  const statuses = Array.from(new Set(allRows.map(r => r.status))).sort()

  const filtered = allRows.filter(r => {
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!r.jobId.toLowerCase().includes(q) && !r.station.toLowerCase().includes(q)) return false
    }
    if (stationFilter && r.station !== stationFilter) return false
    if (statusFilter && r.status !== statusFilter) return false
    if (delayedOnly && (r.delayReason === 'No delay' || r.delayReason === '—')) return false
    return true
  })

  if (allRows.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">No job trace data for this run.</p>
  }

  const tableContent = (
    <div>
      <div className="flex items-center flex-wrap gap-2 mb-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by Job ID or Station…"
            className="w-full pl-8 pr-3 py-1.5 text-sm text-gray-800 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <select
          value={stationFilter}
          onChange={(e) => setStationFilter(e.target.value)}
          className="h-8 text-sm text-gray-700 bg-white border border-gray-200 rounded-lg px-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <option value="">All stations</option>
          {stations.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 text-sm text-gray-700 bg-white border border-gray-200 rounded-lg px-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <option value="">All status</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={() => setDelayedOnly(v => !v)}
          className={`h-8 text-sm px-3 rounded-lg border transition-colors ${
            delayedOnly
              ? 'text-amber-700 bg-amber-50 border-amber-300'
              : 'text-gray-700 bg-white border-gray-200 hover:border-gray-300'
          }`}
        >
          Delayed only
        </button>
        {(search.trim() || stationFilter || statusFilter || delayedOnly) && (
          <button
            onClick={() => { setSearch(''); setStationFilter(''); setStatusFilter(''); setDelayedOnly(false) }}
            className="h-8 text-sm font-medium px-3 rounded-lg text-gray-400 hover:text-gray-600 transition-colors"
          >
            Clear
          </button>
        )}
        <span className="text-xs text-gray-400 ml-auto">{filtered.length} of {allRows.length} rows</span>
      </div>
      <div className={`overflow-auto rounded-xl border border-gray-100 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full ${expanded ? 'max-h-[calc(100vh-260px)]' : 'max-h-[600px]'}`}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr className="border-b border-gray-100">
              {['Job ID', 'Station', 'Processing Start', 'Processing End', 'Waiting (min)', 'Processing (min)', 'Other Delay (min)', 'Total (min)', 'Status', 'Delay Reason'].map(h => (
                <th key={h} className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest py-3 px-4 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((r, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                <td className="py-2.5 px-4 font-medium text-gray-800 whitespace-nowrap">{r.jobId}</td>
                <td className="py-2.5 px-4 text-gray-600 whitespace-nowrap">{r.station}</td>
                <td className="py-2.5 px-4 text-gray-600 whitespace-nowrap">{r.arrival ?? '—'}</td>
                <td className="py-2.5 px-4 text-gray-600 whitespace-nowrap">{r.departure ?? '—'}</td>
                <td className={`py-2.5 px-4 tabular-nums whitespace-nowrap ${r.waitingMin ? 'text-amber-600 font-medium' : 'text-gray-400'}`}>{r.waitingMin ?? '—'}</td>
                <td className="py-2.5 px-4 text-blue-600 font-medium tabular-nums whitespace-nowrap">{r.processingMin ?? '—'}</td>
                <td className={`py-2.5 px-4 tabular-nums whitespace-nowrap ${r.otherTimeMin ? 'text-purple-600 font-medium' : 'text-gray-400'}`}>{r.otherTimeMin || '—'}</td>
                <td className="py-2.5 px-4 text-gray-800 font-semibold tabular-nums whitespace-nowrap">{r.totalMin ?? '—'}</td>
                <td className="py-2.5 px-4 whitespace-nowrap">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                    r.status === 'Completed'
                      ? 'text-green-600 bg-green-50 border-green-200'
                      : r.status === 'In Progress'
                        ? 'text-amber-600 bg-amber-50 border-amber-200'
                        : 'text-gray-500 bg-gray-50 border-gray-200'
                  }`}>
                    {r.status}
                  </span>
                </td>
                <td className={`py-2.5 px-4 whitespace-nowrap ${r.delayReason === 'No delay' || r.delayReason === '—' ? 'text-gray-400' : 'text-gray-700 font-medium'}`}>
                  {r.delayReason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )

  if (!expanded) return tableContent

  return (
    <div className="fixed inset-0 z-[9999] bg-gray-50 flex flex-col p-8 overflow-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-100 [&::-webkit-scrollbar-thumb]:bg-blue-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:bg-blue-500">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm flex-1 flex flex-col p-6 overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-bold text-gray-800">Job Trace</h2>
            <p className="text-xs text-gray-400 mt-0.5">Every job's arrival/departure at each station</p>
          </div>
          <button onClick={onExpandToggle}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-500 hover:border-blue-300 hover:text-blue-600 transition-colors text-xs font-medium">
            <Shrink className="w-3.5 h-3.5" /> Exit
          </button>
        </div>
        {tableContent}
      </div>
    </div>
  )
}

// ─── Gantt chart ──────────────────────────────────────────────────────────────

interface GanttJob {
  station: string
  start: number
  end: number
  processingTime: number
  waitingTime: number
  blockedTime: number
  downtime: number
  jobIndex: number
}

function parseGantt(completionLog: Record<string, unknown[]>): GanttJob[] {
  const jobs: GanttJob[] = []
  for (const [station, entries] of Object.entries(completionLog)) {
    let jobIdx = 0
    for (const e of entries as Record<string, unknown>[]) {
      const startStr = e['process_start_time_real'] as string
      const endStr   = e['process_end_time_real'] as string
      if (!startStr || !endStr) continue
      const start = new Date(startStr.replace(' ', 'T').replace(' ', '')).getTime()
      const end   = new Date(endStr.replace(' ', 'T').replace(' ', '')).getTime()
      jobs.push({
        station,
        start,
        end,
        processingTime: Number(e['Processing Time'] ?? 0),
        waitingTime: Number(e['Waiting Time'] ?? 0),
        blockedTime: Number(e['Blocked Time'] ?? 0),
        downtime: Number(e['station_downtime'] ?? 0),
        jobIndex: ++jobIdx,
      })
    }
  }
  return jobs
}

function GanttTimeline({ result, simTime, onExpandToggle, isExpanded }: { result: Record<string, unknown>; simTime?: number; onExpandToggle?: () => void; isExpanded?: boolean }) {
  const isDark = useAppStore(s => s.theme) === 'dark'
  const svgC = isDark
    ? { rowEven: '#171A1F', rowOdd: '#111418', grid: '#2A2F37', legendBg: '#171A1F', label: '#E9EBEE', muted: '#8C96A7', barBorder: 'rgba(255,255,255,0.12)' }
    : { rowEven: '#F8FAFC', rowOdd: '#FFFFFF', grid: '#E6E9EF', legendBg: '#F8FAFC', label: '#344054', muted: '#8A94A6', barBorder: 'rgba(0,0,0,0.08)' }

  // FIX: `rawLog`/`jobs` are computed up front (instead of via early
  // `return` statements) so that every hook below is called on every
  // render regardless of whether there's data. Previously the two early
  // returns sat *before* the useState/useCallback/useEffect calls, which
  // violates the Rules of Hooks — switching from an empty-data run to a
  // populated one while this component stayed mounted (e.g. via Run
  // History) could throw "Rendered fewer hooks than expected" or corrupt
  // playback/scrub state.
  const rawLog = result?.completion_log as Record<string, unknown[]> | undefined
  const hasLog = !!rawLog && Object.keys(rawLog).length > 0
  const jobs = hasLog ? parseGantt(rawLog!) : []
  const hasJobs = jobs.length > 0

  const stations = [...new Set(jobs.map(j => j.station))]
  // FIX: Math.min(...arr)/Math.max(...arr) spread every element as a
  // function argument, which can throw "Maximum call stack size exceeded"
  // once a simulation produces enough completion-log entries. reduce()
  // avoids the call-stack limit entirely.
  const tMin = jobs.reduce((min, j) => Math.min(min, j.start), Infinity)
  // The configured run length (simTime, in simulated minutes) always wins
  // over the last job's own end time — a run that finishes all its jobs
  // early (e.g. a 200-minute run where the last job ends at 125m) should
  // still show the FULL window the user asked it to run for, empty tail
  // included, not silently crop to whenever activity happened to stop.
  const lastJobEnd = jobs.reduce((max, j) => Math.max(max, j.end), -Infinity)
  const configuredEnd = hasJobs && simTime != null ? tMin + simTime * 60000 : -Infinity
  const tMax = hasJobs ? Math.max(lastJobEnd, configuredEnd) : -Infinity
  const totalMs = hasJobs ? (tMax - tMin || 1) : 1

  const [scrubPct, setScrubPct] = useState(100)
  const [speed, setSpeed] = useState<'1×' | '10×' | '50×'>('10×')
  const [playing, setPlaying] = useState(false)
  const [hoveredJob, setHoveredJob] = useState<{ job: GanttJob; x: number; y: number; clientY: number } | null>(null)
  const expanded = isExpanded ?? false
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const speedMap = { '1×': 1, '10×': 10, '50×': 50 }

  const tick = useCallback((ts: number) => {
    if (lastTsRef.current === null) { lastTsRef.current = ts }
    const delta = ts - lastTsRef.current
    lastTsRef.current = ts
    const advance = (delta * speedMap[speed]) / totalMs * 100
    setScrubPct(prev => {
      const next = prev + advance
      if (next >= 100) { setPlaying(false); return 100 }
      return next
    })
    rafRef.current = requestAnimationFrame(tick)
  }, [speed, totalMs])

  useEffect(() => {
    if (playing) {
      lastTsRef.current = null
      rafRef.current = requestAnimationFrame(tick)
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, tick])

  // Now it's safe to branch on data availability — every hook above has
  // already been called unconditionally on this render.
  if (!hasLog) {
    return <p className="text-sm text-gray-400 py-8 text-center">No completion log data available.</p>
  }
  if (!hasJobs) {
    return <p className="text-sm text-gray-400 py-8 text-center">No jobs to display.</p>
  }

  const cutoffMs = tMin + (scrubPct / 100) * totalMs
  const visibleJobs = jobs.filter(j => j.start <= cutoffMs)

  // Per-station summary
  const stationSummary = stations.map(s => {
    const sJobs = jobs.filter(j => j.station === s)
    const totalProc = sJobs.reduce((a, j) => a + j.processingTime, 0)
    const totalWait = sJobs.reduce((a, j) => a + j.waitingTime, 0)
    const totalBlock = sJobs.reduce((a, j) => a + j.blockedTime, 0)
    return { station: s, count: sJobs.length, totalProc, totalWait, totalBlock }
  })

  // Time axis ticks
  const totalMinutes = totalMs / 60000
  const tickCount = 6
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    pct: i / tickCount,
    label: `${Math.round((i / tickCount) * totalMinutes)}m`,
  }))

  // Station colors — distinct from waiting (#f59e0b amber) and blocked (#ef4444 red) overlays
  const palette = ['#3b82f6','#f97316','#22c55e','#a855f7','#06b6d4','#ec4899','#84cc16','#8b5cf6','#0ea5e9','#14b8a6']
  const stationColor = (s: string) => palette[stations.indexOf(s) % palette.length]

  const ROW_H = 50
  const LABEL_W = 140
  const BAR_H = 24
  const LEGEND_H = 30
  const chartH = LEGEND_H + stations.length * ROW_H + 32
  const CHART_W = 900

  const xPct = (ms: number) => ((ms - tMin) / totalMs)
  const yOf  = (s: string) => LEGEND_H + stations.indexOf(s) * ROW_H + (ROW_H - BAR_H) / 2

  // Current sim time label
  const curMinutes = Math.round((scrubPct / 100) * totalMinutes)

  const chartContent = (_isFullscreen: boolean) => (
    <div className="relative">
      {/* Controls */}
      <div className="flex items-center gap-2 mb-3 pr-24">
        <button onClick={() => { setScrubPct(0); setPlaying(false) }}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 font-medium">
          ↩ Reset
        </button>
        <button onClick={() => setPlaying(p => !p)}
          className="text-xs px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium flex items-center gap-1">
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        {(['1×','10×','50×'] as const).map(s => (
          <button key={s} onClick={() => setSpeed(s)}
            className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${speed === s ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-blue-300'}`}>
            {s}
          </button>
        ))}
        <input type="range" min={0} max={100} step={0.1}
          value={scrubPct}
          onChange={e => { setPlaying(false); setScrubPct(Number(e.target.value)) }}
          className="flex-1 accent-blue-600" />
      </div>

      {/* Chart */}
      <div className="relative rounded-xl border border-gray-100">
        <svg width="100%" viewBox={`0 0 ${LABEL_W + CHART_W} ${chartH}`} style={{ fontFamily: 'inherit', display: 'block' }}>

          {/* Legend header row */}
          <rect x={0} y={0} width={LABEL_W + CHART_W} height={LEGEND_H} fill={svgC.legendBg} />
          <line x1={0} y1={LEGEND_H} x2={LABEL_W + CHART_W} y2={LEGEND_H} stroke={svgC.grid} strokeWidth={1} />
          {/* Legend items */}
          {[
            { color: 'var(--ls-ok)', label: 'Processing' },
            { color: 'var(--ls-warn)', label: 'Waiting' },
            { color: 'var(--ls-bad)', label: 'Blocked/Down' },
          ].map((item, i) => (
            <g key={item.label} transform={`translate(${LABEL_W + 12 + i * 110}, 0)`}>
              <rect x={0} y={LEGEND_H / 2 - 5} width={10} height={10} rx={2} fill={item.color} />
              <text x={14} y={LEGEND_H / 2 + 4} fontSize={9} fill={svgC.muted}>{item.label}</text>
            </g>
          ))}
          {/* Time counter in legend row — right aligned */}
          <text x={LABEL_W + CHART_W - 8} y={LEGEND_H / 2 + 4} textAnchor="end" fontSize={9} fontWeight="600" fill={svgC.label}>
            {curMinutes}m / {Math.round(totalMinutes)}m
          </text>

          {/* Row backgrounds */}
          {stations.map((s, i) => (
            <rect key={s} x={0} y={LEGEND_H + i * ROW_H} width={LABEL_W + CHART_W} height={ROW_H}
              fill={i % 2 === 0 ? svgC.rowEven : svgC.rowOdd} />
          ))}

          {/* Time grid lines */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={LABEL_W + t.pct * CHART_W} y1={LEGEND_H}
                    x2={LABEL_W + t.pct * CHART_W} y2={chartH - 20}
                    stroke={svgC.grid} strokeWidth={1} />
              <text
                x={LABEL_W + t.pct * CHART_W}
                y={chartH - 6}
                textAnchor={i === tickCount ? 'end' : i === 0 ? 'start' : 'middle'}
                fontSize={9} fill={svgC.muted}>{t.label}</text>
            </g>
          ))}

          {/* Station labels */}
          {stations.map((s, i) => (
            <g key={s}>
              <rect x={0} y={LEGEND_H + i * ROW_H} width={LABEL_W - 4} height={ROW_H}
                fill={i % 2 === 0 ? svgC.rowEven : svgC.rowOdd} />
              <circle cx={10} cy={LEGEND_H + i * ROW_H + ROW_H / 2} r={4}
                fill={stationColor(s)} />
              <text x={20} y={LEGEND_H + i * ROW_H + ROW_H / 2 + 4}
                fontSize={11} fill={svgC.label} fontWeight="600">
                {s.length > 18 ? s.slice(0, 17) + '…' : s}
              </text>
            </g>
          ))}

          {/* Divider line between labels and chart */}
          <line x1={LABEL_W} y1={LEGEND_H} x2={LABEL_W} y2={chartH - 20} stroke={svgC.grid} strokeWidth={1} />

          {/* Job bars */}
          {visibleJobs.map((j, idx) => {
            const x1 = LABEL_W + xPct(j.start) * CHART_W
            const x2 = LABEL_W + xPct(Math.min(j.end, cutoffMs)) * CHART_W
            const w = Math.max(2, x2 - x1)
            const y = yOf(j.station)
            const totalDur = j.end - j.start
            // Compute clean pixel widths for each segment (proc | wait | blocked)
            const procW  = totalDur > 0 ? Math.max(0, (j.processingTime * 60000 / totalDur) * w) : w
            const waitW  = totalDur > 0 ? Math.max(0, (j.waitingTime  * 60000 / totalDur) * w) : 0
            const blockW = totalDur > 0 ? Math.max(0, (j.blockedTime  * 60000 / totalDur) * w) : 0
            // Clamp so they don't exceed total width
            const total3 = procW + waitW + blockW
            const scale  = total3 > w ? w / total3 : 1
            const pw = procW  * scale
            const ww = waitW  * scale
            const bw = blockW * scale

            return (
              <g key={idx}
                onMouseEnter={e => {
                  const svg = (e.currentTarget as SVGElement).closest('svg')!.getBoundingClientRect()
                  setHoveredJob({ job: j, x: e.clientX - svg.left, y: e.clientY - svg.top, clientY: e.clientY })
                }}
                onMouseLeave={() => setHoveredJob(null)}
                style={{ cursor: 'pointer' }}
              >
                {/* Processing segment — green */}
                {pw > 0 && <rect x={x1} y={y} width={pw} height={BAR_H} fill="var(--ls-ok)" rx={2} />}
                {/* Waiting segment — yellow */}
                {ww > 0 && <rect x={x1 + pw} y={y} width={ww} height={BAR_H} fill="var(--ls-warn)" rx={0} />}
                {/* Blocked segment — red */}
                {bw > 0 && <rect x={x1 + pw + ww} y={y} width={bw} height={BAR_H} fill="var(--ls-bad)" rx={0} />}
                {/* Thin border around full bar for definition */}
                <rect x={x1} y={y} width={w} height={BAR_H} fill="none" stroke={svgC.barBorder} strokeWidth={0.5} rx={2} />
              </g>
            )
          })}

          {/* Cursor line */}
          {scrubPct < 100 && (
            <line
              x1={LABEL_W + (scrubPct / 100) * CHART_W} y1={LEGEND_H}
              x2={LABEL_W + (scrubPct / 100) * CHART_W} y2={chartH - 20}
              stroke="var(--ls-accent)" strokeWidth={1.5} strokeDasharray="4 3" />
          )}
        </svg>

        {/* Hover tooltip */}
        {hoveredJob && (() => {
          const { job, x, y, clientY } = hoveredJob
          const flipLeft = x > LABEL_W + CHART_W * 0.6
          // The tooltip's own height (~190px incl. downtime row) can push it
          // past the bottom of the actual browser viewport when hovering a
          // job near the bottom of a tall, scrollable Gantt chart — clientY
          // is viewport-relative (unlike x/y, which are SVG-relative and
          // don't know how much of the SVG is actually visible on screen).
          const TOOLTIP_H = 190
          const flipUp = clientY + TOOLTIP_H > window.innerHeight
          return (
            <div className="pointer-events-none absolute z-50 bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-56"
              style={{
                left: flipLeft ? x - 220 : x + 12,
                top: flipUp ? Math.max(0, y - TOOLTIP_H) : Math.max(0, y - 10),
              }}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: stationColor(job.station) }} />
                <span className="text-xs font-bold text-gray-800">{job.station}</span>
                <span className="ml-auto text-[10px] text-gray-400">Job #{job.jobIndex}</span>
              </div>
              <div className="space-y-1 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-gray-500">Start</span>
                  <span className="font-semibold tabular-nums text-gray-800">{Math.round((job.start - tMin) / 60000)} min</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">End</span>
                  <span className="font-semibold tabular-nums text-gray-800">{Math.round((job.end - tMin) / 60000)} min</span>
                </div>
                <div className="border-t border-gray-100 my-1" />
                <div className="flex justify-between">
                  <span className="text-blue-600">Processing</span>
                  <span className="font-semibold text-blue-700">{job.processingTime.toFixed(1)} min</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-amber-500">Waiting</span>
                  <span className="font-semibold text-amber-600">{job.waitingTime.toFixed(1)} min</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-red-500">Blocked</span>
                  <span className="font-semibold text-red-600">{job.blockedTime.toFixed(1)} min</span>
                </div>
                {job.downtime > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Downtime</span>
                    <span className="font-semibold text-gray-700">{job.downtime.toFixed(1)} min</span>
                  </div>
                )}
              </div>
            </div>
          )
        })()}
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-3 mt-4">
        {stationSummary.map(s => (
          <div key={s.station} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: stationColor(s.station) }} />
              <span className="text-[11px] font-semibold text-gray-700 truncate">{s.station}</span>
            </div>
            <div className="flex gap-3 text-[10px] text-gray-500">
              <span><b className="text-gray-800">{s.count}</b> jobs</span>
              <span><b className="text-blue-600">{s.totalProc.toFixed(0)}m</b> proc</span>
              <span><b className="text-amber-500">{s.totalWait.toFixed(0)}m</b> wait</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div>
      {expanded && (
        <div className="fixed inset-0 z-[9999] bg-gray-50 flex flex-col p-8 overflow-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-100 [&::-webkit-scrollbar-thumb]:bg-blue-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:bg-blue-500">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm flex-1 flex flex-col p-6 overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-gray-800">Gantt Chart</h2>
                <p className="text-xs text-gray-400 mt-0.5">Job timeline by station</p>
              </div>
              <button onClick={onExpandToggle}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-500 hover:border-blue-300 hover:text-blue-600 transition-colors text-xs font-medium">
                <Shrink className="w-3.5 h-3.5" /> Exit
              </button>
            </div>
            {chartContent(true)}
          </div>
        </div>
      )}
      {chartContent(false)}
    </div>
  )
}

// ─── Charts ───────────────────────────────────────────────────────────────────

const POPUP_WIDTH = 240
const POPUP_MARGIN = 12

function StationHealthGrid({ stats }: { stats: StationStat[] }) {
  const [popup, setPopup] = useState<{ stat: StationStat; x: number; anchorX: number; y: number; below: boolean } | null>(null)

  return (
    <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
      {stats.map((s) => (
        <div
          key={s.station_name}
          onMouseEnter={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            // Popup height grows with the metrics list (2-column grid, ~40px
            // per row) plus header/padding/arrow — estimate rather than
            // hard-code so adding another metric doesn't silently break this.
            const estimatedPopupHeight = 380
            const spaceAbove = rect.top
            const spaceBelow = window.innerHeight - rect.bottom
            // Prefer whichever side actually has room; if neither does, use
            // whichever has more space so it's clipped as little as possible.
            const below = spaceBelow >= estimatedPopupHeight
              ? true
              : spaceAbove >= estimatedPopupHeight
                ? false
                : spaceBelow > spaceAbove
            const anchorX = rect.left + rect.width / 2
            // clamp horizontally so the fixed-width popup never overflows the viewport
            const half = POPUP_WIDTH / 2
            const x = Math.min(
              Math.max(anchorX, half + POPUP_MARGIN),
              window.innerWidth - half - POPUP_MARGIN
            )
            setPopup({ stat: s, x, anchorX, y: below ? rect.bottom : rect.top, below })
          }}
          onMouseLeave={() => setPopup(null)}
          className={`relative p-2 rounded-lg border text-center cursor-default ${utilBg(s.station_utilization)}`}
        >
          <div className="absolute top-0 left-0 right-0 h-1 rounded-t-lg"
            style={{ background: utilColor(s.station_utilization) }} />
          <p className="text-xs font-medium text-gray-700 leading-tight mt-1 truncate" style={{ fontSize: 10 }}>
            {s.station_name}
          </p>
          <p className={`text-sm font-bold mt-0.5 ${utilTextColor(s.station_utilization)}`}>
            {s.station_utilization.toFixed(0)}%
          </p>
        </div>
      ))}

      {popup && (() => {
        const s = popup.stat
        const color = utilColor(s.station_utilization)
        const metrics = [
          { label: 'Station Util.', value: `${s.station_utilization.toFixed(1)}%`, badge: utilTextColor(s.station_utilization) },
          { label: 'Operator Util.', value: `${s.operator_utilization.toFixed(1)}%`, badge: 'text-blue-600' },
          { label: 'No. of Stations', value: String(s.capacity ?? 1), badge: 'text-gray-700' },
          { label: 'Operators', value: String(s.operator_per_station ?? 1), badge: 'text-gray-700' },
          { label: 'Jobs Completed', value: String(s.completed_jobs), badge: 'text-gray-700' },
          { label: 'Failures', value: String(s.failure_breakdowns), badge: s.failure_breakdowns > 0 ? 'text-red-500' : 'text-gray-400' },
          { label: 'Rework Rate', value: `${s.rework_percentage.toFixed(1)}%`, badge: s.rework_percentage > 5 ? 'text-amber-600' : 'text-gray-400' },
          { label: 'Rework Time', value: `${s.rework_time_ratio.toFixed(1)}%`, badge: s.rework_time_ratio > 10 ? 'text-amber-600' : 'text-gray-400' },
          { label: 'Setup Time', value: `${(s.setup_time_ratio ?? 0).toFixed(1)}%`, badge: (s.setup_time_ratio ?? 0) > 10 ? 'text-purple-600' : 'text-gray-400' },
          { label: 'Buffer Blocked', value: `${(s.buffer_blocked_ratio ?? 0).toFixed(1)}%`, badge: (s.buffer_blocked_ratio ?? 0) > 10 ? 'text-rose-600' : 'text-gray-400' },
          { label: 'Throughput', value: `${s.throughput.toFixed(2)} /hr`, badge: 'text-indigo-600' },
          // Conveyor only — the belt's own settings for this run.
          ...(s.conveyor_length != null ? [{ label: 'Length', value: `${+s.conveyor_length.toFixed(2)} m`, badge: 'text-gray-700' }] : []),
          ...(s.conveyor_speed != null ? [{ label: 'Speed', value: `${+s.conveyor_speed.toFixed(2)} m/min`, badge: 'text-gray-700' }] : []),
          ...(s.transport_time != null ? [{ label: 'Transport Time', value: `${+s.transport_time.toFixed(2)} min`, badge: 'text-gray-700' }] : []),
          ...(s.sensor_passed != null ? [{ label: 'Jobs passed sensor', value: `${s.sensor_passed}`, badge: 'text-gray-700' }] : []),
        ]
        const arrowOffset = popup.anchorX - popup.x
        return (
          <div
            className="fixed z-[9999] pointer-events-none"
            style={{
              left: popup.x,
              top: popup.below ? popup.y + 8 : popup.y - 8,
              transform: popup.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
          >
            {/* Arrow above popup when flipped below */}
            {popup.below && (
              <div className="flex justify-center mb-0" style={{ transform: `translateX(${arrowOffset}px)` }}>
                <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-white drop-shadow-sm" />
              </div>
            )}
            <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden w-60">
              {/* Coloured header */}
              <div className="px-4 py-3" style={{ background: color + '22' }}>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <p className="text-[11px] font-bold text-gray-800 leading-tight">{s.station_name}</p>
                </div>
                {/* Utilisation bar */}
                <div className="flex items-center gap-2 mt-2">
                  <div className="flex-1 h-1.5 bg-white/60 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(s.station_utilization, 100)}%`, background: color }} />
                  </div>
                  <span className="text-[10px] font-bold tabular-nums" style={{ color }}>{s.station_utilization.toFixed(1)}%</span>
                </div>
              </div>
              {/* Metrics grid */}
              <div className="px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {metrics.map(({ label, value, badge }) => (
                  <div key={label}>
                    <p className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</p>
                    <p className={`text-xs font-bold tabular-nums mt-0.5 ${badge}`}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
            {/* Arrow pointing down to the card (when popup is above) */}
            {!popup.below && (
              <div className="flex justify-center" style={{ transform: `translateX(${arrowOffset}px)` }}>
                <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-white drop-shadow-sm" />
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

function StationTable({ stats, onSelect }: { stats: StationStat[]; onSelect?: (name: string) => void }) {
  const th = (label: string) => (
    <th className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider py-3 px-4 whitespace-nowrap">
      {label}
    </th>
  )

  const statusConfig = (u: number) => {
    if (u >= 85) return { label: 'Bottleneck', cls: 'text-red-600 bg-red-50 border border-red-200', dot: 'bg-red-500' }
    if (u >= 70) return { label: 'High Load',  cls: 'text-amber-600 bg-amber-50 border border-amber-200', dot: 'bg-amber-400' }
    if (u >= 40) return { label: 'Healthy',    cls: 'text-green-600 bg-green-50 border border-green-200', dot: 'bg-green-500' }
    return              { label: 'Idle',       cls: 'text-gray-400 bg-gray-50 border border-gray-200', dot: 'bg-gray-300' }
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-gray-100 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-blue-300 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-blue-400">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            {th('Station')}
            {th('Utilization')}
            {th('Operator')}
            {th('Jobs')}
            {th('Failures')}
            {th('Rework Rate %')}
            {th('Status')}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {stats.map((s, idx) => {
            const u = s.station_utilization
            const { label, cls, dot } = statusConfig(u)
            return (
              <tr
                key={s.station_name}
                onClick={() => onSelect?.(s.station_name)}
                className={`hover:bg-blue-50/40 transition-colors duration-100 ${onSelect ? 'cursor-pointer' : ''} ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}
              >
                {/* Station name */}
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: utilColor(u) }} />
                    <span className="font-semibold text-gray-800 text-sm">{s.station_name}</span>
                  </div>
                </td>

                {/* Utilization */}
                <td className="py-3 px-4">
                  <span className={`text-sm font-bold tabular-nums ${utilTextColor(u)}`}>
                    {u.toFixed(1)}%
                  </span>
                </td>

                {/* Operator */}
                <td className="py-3 px-4">
                  <span className="text-sm text-gray-600 tabular-nums">{s.operator_utilization.toFixed(1)}%</span>
                </td>

                {/* Jobs */}
                <td className="py-3 px-4">
                  <span className="text-sm font-semibold text-gray-700 tabular-nums">{s.completed_jobs}</span>
                </td>

                {/* Failures */}
                <td className="py-3 px-4">
                  <span className={`text-sm font-semibold tabular-nums ${s.failure_breakdowns > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                    {s.failure_breakdowns}
                  </span>
                </td>

                {/* Rework % */}
                <td className="py-3 px-4">
                  <span className={`text-sm font-semibold tabular-nums ${s.rework_percentage > 5 ? 'text-amber-600' : 'text-gray-600'}`}>
                    {s.rework_percentage.toFixed(1)}%
                  </span>
                </td>

                {/* Status pill */}
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${cls}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                    {label}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Workers (Worker Controller pools) ────────────────────────────────────────

// Each pooled Worker's worked time (from starting a job until released),
// jobs done and share of the run, and where it worked.
function WorkerTable({ pools }: { pools: Record<string, WorkerPoolStat> }) {
  const th = (label: string) => (
    <th className="text-left text-xs font-semibold text-gray-400 uppercase tracking-wider py-3 px-4 whitespace-nowrap">
      {label}
    </th>
  )
  const rows = Object.entries(pools).flatMap(([controller, p]) => (p.workers ?? []).map((w) => ({ controller, w })))
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            {th('Worker')}
            {th('Worker Controller')}
            {th('Worked Time')}
            {th('Jobs')}
            {th('Utilization')}
            {th('Worked At')}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map(({ controller, w }, idx) => (
            <tr
              key={`${controller}|${w.name}`}
              className={`hover:bg-blue-50/40 transition-colors duration-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}
            >
              <td className="py-3 px-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: utilColor(w.utilization) }} />
                  <span className="font-semibold text-gray-800 text-sm">{w.name}</span>
                </div>
              </td>
              <td className="py-3 px-4"><span className="text-sm text-gray-600">{controller}</span></td>
              <td className="py-3 px-4"><span className="text-sm font-semibold text-gray-700 tabular-nums">{w.worked_time.toFixed(1)} min</span></td>
              <td className="py-3 px-4"><span className="text-sm font-semibold text-gray-700 tabular-nums">{w.jobs}</span></td>
              <td className="py-3 px-4">
                <span className={`text-sm font-bold tabular-nums ${utilTextColor(w.utilization)}`}>{w.utilization.toFixed(1)}%</span>
              </td>
              <td className="py-3 px-4">
                <span className="text-xs text-gray-600">
                  {w.workplaces.length === 0 ? '—' : w.workplaces.map((p) => `${p.station}: ${p.worked_time.toFixed(1)} min (${p.jobs} job${p.jobs === 1 ? '' : 's'})`).join(' · ')}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'kpis' | 'gantt' | 'jobtrace'

// Overview = the KPI cards and charts, Detect = the job timeline, Trace = the per-job table.
const TABS: { key: Tab; label: string }[] = [
  { key: 'kpis', label: 'Overview' },
  { key: 'gantt', label: 'Detect' },
  { key: 'jobtrace', label: 'Trace' },
]

export default function RunDashboard() {
  const navigate = useNavigate()
  const { activeScenario } = useAppStore()
  const {
    displayRun, simCfg, setSimCfg, persistSimConfig, progress, isRunning,
    start, stop, canStop, stopPending,
  } = useRunSimulation()
  const [tabState, setTab] = useState<Tab>('kpis')
  // The left menu: Dashboard is the tabbed Overview page; KPIs and Gantt reuse its views; the rest show one graph.
  const [graph, setGraph] = useState<GraphKey>('dash')
  const tab: Tab | 'none' = graph === 'dash' || displayRun?.status !== 'completed' ? tabState : graph === 'kpis' ? 'kpis' : graph === 'gantt' ? 'gantt' : 'none'
  const series = useRunSeries(displayRun?.result?.completion_log as Record<string, unknown[]> | undefined, displayRun?.station_stats ?? [])
  const [ganttExpanded, setGanttExpanded] = useState(false)
  const [jobTraceExpanded, setJobTraceExpanded] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [timerOpen, setTimerOpen] = useState(false)
  const [drawerStation, setDrawerStation] = useState<string | null>(null)
  const [dataTable, setDataTable] = useState<DataTableProps | null>(null)
  if (!activeScenario) {
    return (
      <div className="min-h-full p-8">
        <div className="max-w-5xl mx-auto">
          <div className="rounded-2xl border border-gray-100 bg-white/70 py-32 flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center">
              <Play className="h-8 w-8 text-blue-400" />
            </div>
            <p className="text-gray-700 font-semibold text-lg">No scenario selected</p>
            <p className="text-sm text-gray-400">Select a scenario first to run simulations and view results.</p>
            <Button
              onClick={() => navigate('/')}
              className="bg-blue-600 hover:bg-blue-700 shadow-sm mt-2"
            >
              Go to Scenarios
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Start (Source) and End (Drain) are entry/exit markers the engine tracks
  // as zero-time passthroughs, not real work — the backend still reports a
  // station_stats row for them (their machine/resource technically exists),
  // so every KPI card built from `stats` needs this filter, not just one
  // card, or they'd keep showing up as if they were real stations wherever
  // a card wasn't individually fixed.
  const allStats = displayRun?.station_stats ?? []
  const stats = allStats.filter((s) => {
    const t = activeScenario.stations_data[s.station_name]?.['Station Type']
    return t !== 'Source' && t !== 'Drain'
  })

  // KPIs — all pre-calculated by backend
  const simTime = displayRun?.simulation_time ?? 0
  const completedJobs = displayRun?.completed_jobs ?? 0
  const inProgressJobs = displayRun?.in_progress_jobs ?? 0
  const scrappedJobs = Number((displayRun?.result?.simulation_state as { scrapped_jobs?: number } | undefined)?.scrapped_jobs ?? 0)
  // Problems found before the run that didn't stop it (e.g. an Assembly
  // whose part quantities can't all be used).
  const runWarnings = ((displayRun?.result?.simulation_state as { warnings?: string[] } | undefined)?.warnings ?? [])
  const throughput = displayRun?.kpi_throughput != null ? displayRun.kpi_throughput.toFixed(4) : '0.0000'
  const avgUtil = displayRun?.kpi_avg_utilization ?? 0
  const peakUtil = displayRun?.kpi_peak_utilization ?? 0
  const bottleneck = displayRun?.kpi_bottleneck_station
    ? stats.find(s => s.station_name === displayRun.kpi_bottleneck_station) ?? null
    : null
  const atRisk = displayRun?.kpi_stations_at_risk ?? 0
  const totalFailures = displayRun?.kpi_total_failures ?? 0
  const totalRework = displayRun?.kpi_avg_rework_pct ?? 0
  const simDays = displayRun?.kpi_sim_days?.toFixed(1) ?? '0.0'

  const utilizationCards = (
    <StationLanes
      stats={stats}
      onData={setDataTable}
    />
  )

  return (
    <>
      <TipHost />
      <SimConfigDialog
        open={configOpen}
        value={simCfg}
        onChange={persistSimConfig}
        onClose={() => setConfigOpen(false)}
      />

      <SimTimerDialog
        open={timerOpen}
        value={simCfg}
        onChange={setSimCfg}
        onClose={() => setTimerOpen(false)}
        progress={progress}
        onRun={(cfg) => start(cfg)}
        isRunning={isRunning}
        completionLog={displayRun?.result?.completion_log as Record<string, unknown[]> | undefined}
      />

      <Drawer open={drawerStation !== null} onClose={() => setDrawerStation(null)} title={drawerStation ?? ''} eyebrow="Station">
        {drawerStation && (
          <StationDrawer
            stat={stats.find((x) => x.station_name === drawerStation)}
            states={(displayRun?.result?.station_states as Record<string, StationStateStat> | undefined)?.[drawerStation]}
          />
        )}
      </Drawer>
      <Drawer open={dataTable !== null} onClose={() => setDataTable(null)} title={dataTable?.title ?? ''} eyebrow="Data">
        {dataTable && <DataTable {...dataTable} />}
      </Drawer>

      <div className="flex h-full">
        <GraphMenu value={graph} onChange={setGraph} />

        {/* Main */}
        <div className="print-main flex-1 min-w-0 p-6 overflow-auto">
          {/* Header */}
          <div className="print:hidden flex items-center justify-between flex-wrap gap-3 mb-5 max-w-full">
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <div className="min-w-0 shrink-0">
              <h1 className="text-xl font-bold text-gray-900">{activeScenario.name}</h1>
              <p className="text-sm text-gray-400 mt-0.5">
                {/* Show the SELECTED RUN's actual simulated duration (not the
                    config dialog's pending SIM_TIME), so this updates per-run
                    when switching between runs in history. */}
                {displayRun?.simulation_time != null ? Math.round(displayRun.simulation_time) : (simCfg.SIM_TIME ?? '?')} min sim · {Object.values(activeScenario.stations_data).filter((c) => c['Station Type'] !== 'Source' && c['Station Type'] !== 'Drain').length} stations ·{' '}
                {Object.keys(activeScenario.variant_quantities).length} variants
                {displayRun?.num_replications && displayRun.num_replications > 1 ? ` · ${displayRun.num_replications} reps` : ''}
              </p>
            </div>
            {displayRun?.status === 'completed' && (
              <div className="flex gap-0.5 rounded-xl bg-ls-line p-[3px]">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => { setTab(t.key); setGraph('dash') }}
                    className={`h-[34px] rounded-[9px] px-3.5 text-[13px] transition-colors ${tab === t.key ? 'bg-ls-card font-semibold text-ls-ink shadow-sm' : 'font-medium text-ls-ink2 hover:text-ls-ink'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            </div>
            <div className="flex gap-2 flex-wrap justify-end">
              <SimSettingsMenu small onConfig={() => setConfigOpen(true)} onTimer={() => setTimerOpen(true)} />
              {displayRun?.status === 'completed' && (
                <Button variant="outline" size="sm" onClick={() => window.print()}>
                  <Printer className="h-4 w-4 mr-1.5" />
                  Export PDF
                </Button>
              )}
              {(isRunning || displayRun?.status === 'running') && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={stop}
                  disabled={stopPending || !canStop}
                  className="border-red-200 text-red-600 hover:bg-red-50 rounded-lg"
                  title="Stop this run at its next checkpoint — partial results up to that point are kept"
                >
                  <Square className="h-4 w-4 mr-1.5" />
                  {stopPending ? 'Stopping…' : 'Stop'}
                </Button>
              )}
              <Button size="sm" onClick={() => start()} disabled={isRunning}>
                {isRunning ? (
                  <><RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />Running…</>
                ) : (
                  <><Play className="h-4 w-4 mr-1.5" />Run Simulation</>
                )}
              </Button>
            </div>
          </div>

          {/* Live progress */}
          {progress && (
            <Card className="mb-5 border-blue-200 bg-blue-50">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 text-blue-600 animate-spin" />
                    <span className="text-sm font-medium text-blue-700">{progress.msg}</span>
                  </div>
                  <span className="text-sm font-bold text-blue-700">{progress.pct.toFixed(0)}%</span>
                </div>
                <Progress value={progress.pct} className="h-2" />
                {progress.simTimeNow != null && progress.simTimeTotal != null && progress.simTimeTotal > 0 && (
                  <p className="text-xs text-blue-600 mt-2 tabular-nums">
                    Simulated time: {(progress.simTimeNow / 1440).toFixed(1)} / {(progress.simTimeTotal / 1440).toFixed(1)} days
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Status + tabs — back in its original spot above the KPI cards.
              Hidden (not the KPI cards below) when there's no run selected
              (initial empty state, or right after Reset), since there's no
              run to show a status badge for. */}
          {displayRun && (
            <div className="no-print flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <StatusBadge status={displayRun.status} />
                {displayRun.status === 'completed' && <CheckCircle className="h-4 w-4 text-green-500" />}
                {displayRun.status === 'failed' && <AlertTriangle className="h-4 w-4 text-red-500" />}
                <span className="text-sm text-gray-400">Run #{displayRun.id}</span>
              </div>
            </div>
          )}

          {displayRun?.status === 'completed' && tab === 'kpis' && graph === 'dash' && <SectionNav />}

          {/* KPI cards — shown on the KPIs tab, same as before the tabs
              existed, so selecting Timeline/Job Trace replaces them entirely
              instead of leaving them visible above that panel. The one
              exception is when there's no run at all (Reset, or the initial
              empty state): the tabs themselves are hidden then (see the
              status/tabs row above), so there's no "Timeline tab selected"
              to conflict with — show the zeroed 0-0 cards regardless of
              `tab`, rather than a blank area with nothing in it. */}
          {(!displayRun || tab === 'kpis') && (
            <>
              {displayRun?.status === 'completed' && <SectionHeading id="sec-measures" title="All measures" note="Click a card for the numbers behind it" first />}
              {runWarnings.length > 0 && (
                <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-xs font-bold text-amber-800 mb-1">Warning{runWarnings.length > 1 ? 's' : ''}</p>
                  {runWarnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 auto-rows-fr">
                <CompletedJobsCard completed={completedJobs} inProgress={inProgressJobs} scrapped={scrappedJobs} stats={stats} spark={series?.rows.map((r) => r.cum as number)} />
                <ThroughputCard value={`${throughput} /hr`} sub="jobs per hour" stats={stats} spark={series?.rows.map((r) => r.done as number)} />
                <SimDurationCard simDays={simDays} simTime={simTime} simCfg={simCfg} />
                <PeakUtilCard peakUtil={peakUtil} bottleneck={bottleneck} stats={stats} spark={displayRun?.kpi_bottleneck_station ? series?.rows.map((r) => (r[displayRun.kpi_bottleneck_station as string] as number) ?? 0) : undefined} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 auto-rows-fr">
                <AvgUtilCard avgUtil={avgUtil} stats={stats} spark={series?.rows.map((r) => r.avg as number)} />
                <BottleneckCard bottleneck={bottleneck} stats={stats} />
                <AtRiskCard count={atRisk} stats={stats} />
                <TotalFailuresCard total={totalFailures} rework={totalRework} stats={stats} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 auto-rows-fr">
                <AvgSetupCard stats={stats} />
                <AvgBufferBlockedCard stats={stats} />
                <AvgCycleTimeCard stats={stats} />
                <MtbfCard simTime={simTime} stats={stats} stationsData={activeScenario.stations_data} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 auto-rows-fr">
                <AvailabilityCard simTime={simTime} stats={stats} stationsData={activeScenario.stations_data} />
                <StatisticalAnalysisCard result={displayRun?.result ?? null} />
              </div>
            </>
          )}

          {displayRun?.status === 'completed' && !['dash', 'kpis', 'gantt'].includes(graph) && (
            <>
              <SectionHeading id="graph-view" title={GRAPHS.find((g) => g.key === graph)!.label} note={GRAPHS.find((g) => g.key === graph)!.sub} first />
              {graph === 'bar' && utilizationCards}
              {graph === 'stacked' && <StateCharts only="stacked" result={displayRun.result} stats={stats} onStation={setDrawerStation} onData={setDataTable} />}
              {graph === 'pie' && <StateCharts only="pie" result={displayRun.result} stats={stats} onStation={setDrawerStation} onData={setDataTable} />}
              {graph === 'line' && <RunTimeline only="line" data={series} onData={setDataTable} />}
              {graph === 'area' && <RunTimeline only="area" data={series} onData={setDataTable} />}
              {graph === 'hist' && <LeadTimeHistogram completionLog={displayRun.result?.completion_log as Record<string, unknown[]> | undefined} onData={setDataTable} />}
              {graph === 'heat' && <ShiftHeatmap completionLog={displayRun.result?.completion_log as Record<string, unknown[]> | undefined} onData={setDataTable} />}
            </>
          )}

          {displayRun && (
            <div className="relative">
              {displayRun.status === 'failed' && (
                <Card className="mb-5 border-red-200 bg-red-50">
                  <CardContent className="pt-4 pb-4 text-sm text-red-700">
                    {displayRun.error_message?.split('\n')[0]}
                  </CardContent>
                </Card>
              )}

              {displayRun.status === 'completed' && (
                <>
                  {tab === 'kpis' && graph === 'dash' && (
                    <>
                      {Object.keys(activeScenario.variant_intervals ?? {}).length > 0 && (
                        <>
                        <SectionHeading id="sec-arrivals" title="Job arrivals" note="How the scenario feeds jobs in" />
                        <Card className="mb-5">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-semibold text-gray-700">Job Arrival Schedule</CardTitle>
                            <p className="text-xs text-gray-400">How often a new job of each variant enters the simulation</p>
                          </CardHeader>
                          <CardContent>
                            <div className="flex flex-wrap gap-3">
                              {Object.entries(activeScenario.variant_quantities ?? {}).map(([variant, qty]) => {
                                const interval = activeScenario.variant_intervals?.[variant]
                                return (
                                  <div key={variant} className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-100 bg-ls-soft min-w-[180px]">
                                    <div className="p-2 rounded-lg bg-ls-chip shrink-0">
                                      <CalendarDays className="h-4 w-4 text-ls-purple" />
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-gray-800 truncate">{variant}</p>
                                      <p className="text-xs text-gray-400 mt-0.5">{qty} jobs</p>
                                      <p className="text-xs font-bold mt-0.5" style={{ color: interval ? 'var(--ls-purple)' : 'var(--ls-mute)' }}>
                                        {interval ? `every ${interval} min` : 'all at once'}
                                      </p>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </CardContent>
                        </Card>
                        </>
                      )}

                      {stats.length > 0 && (
                        <>
                          <SectionHeading id="sec-stations" title="Stations" note="How each station did" />
                          <Card className="mb-5">
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm font-semibold text-gray-700">Station Health Overview</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <StationHealthGrid stats={stats} />
                            </CardContent>
                          </Card>

                          <Card>
                            <CardHeader className="pb-2">
                              <div className="flex items-center justify-between">
                                <CardTitle className="text-sm font-semibold text-gray-700">Station Details</CardTitle>
                                <button
                                  onClick={() => navigate('/interfaces')}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ls-dark text-ls-card text-xs font-semibold shadow-sm hover:opacity-90 transition-all"
                                >
                                  <Lightbulb className="h-3 w-3" />
                                  AI Insights
                                </button>
                              </div>
                            </CardHeader>
                            <CardContent>
                              <StationTable stats={stats} onSelect={setDrawerStation} />
                            </CardContent>
                          </Card>

                          {/* Workers: only when the run had Worker Controller pools. */}
                          {Object.values(displayRun?.result?.worker_pool_stats ?? {}).some((p) => (p.workers ?? []).length > 0) && (
                            <Card className="mt-5">
                              <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                  <CardTitle className="text-sm font-semibold text-gray-700">Workers</CardTitle>
                                  <span className="text-xs text-gray-400">Worked time: from starting a job until released · Utilization: share of the run</span>
                                </div>
                              </CardHeader>
                              <CardContent>
                                <WorkerTable pools={displayRun!.result!.worker_pool_stats!} />
                              </CardContent>
                            </Card>
                          )}
                          <SectionHeading id="sec-output" title="Output over time" note="From the run's own job log" />
                          <RunTimeline
                            data={series}
                            onData={setDataTable}
                          />

                          <SectionHeading id="sec-utilization" title="Utilization" note="How busy stations and operators were" />
                          {utilizationCards}

                          <StationThroughput stats={stats} bottleneck={displayRun.kpi_bottleneck_station ?? null} lineOutput={displayRun.kpi_throughput ?? null} />

                          <SectionHeading id="sec-time" title="Time and delay" note="Where the time went" />
                          <StateCharts result={displayRun.result} stats={stats} onStation={setDrawerStation} onData={setDataTable} />

                          <ShiftHeatmap completionLog={displayRun.result?.completion_log as Record<string, unknown[]> | undefined} onData={setDataTable} />

                        </>
                      )}
                    </>
                  )}

                  {tab === 'gantt' && (
                    <BottleneckPanel
                      bottleneck={bottleneck}
                      result={displayRun.result}
                      order={(Object.values(activeScenario.processflow_data ?? {})[0] ?? []).flatMap((st) => (typeof st.resource === 'string' ? [st.resource] : st.resource?.options ?? []))}
                      repairMin={bottleneck ? (activeScenario.stations_data[bottleneck.station_name]?.['Repair Time'] as number | undefined) : undefined}
                    />
                  )}

                  {tab === 'gantt' && (
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-semibold text-gray-700">
                            Job Timeline — {completedJobs} jobs across {stats.length} stations
                          </CardTitle>
                          <button onClick={() => setGanttExpanded(e => !e)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600 transition-colors text-xs font-medium">
                            <Expand className="w-3.5 h-3.5" /> Expand
                          </button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <GanttTimeline result={displayRun.result ?? {}} simTime={displayRun.simulation_time ?? undefined} isExpanded={ganttExpanded} onExpandToggle={() => setGanttExpanded(e => !e)} />
                        <ChartKey
                          colors={[
                            { color: 'var(--ls-ok)', label: 'Processing', note: 'a job being worked on' },
                            { color: 'var(--ls-warn)', label: 'Waiting', note: 'a job waiting for this station' },
                          ]}
                          x="Simulation time, in minutes from the start of the run"
                          y="Stations; each bar is one job's visit"
                          measure="Each block runs from when a job reached the station to when it left, split into waiting and processing."
                        />
                      </CardContent>
                    </Card>
                  )}

                  {tab === 'jobtrace' && (
                    <>
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-semibold text-gray-700">
                            Job Trace — every job's arrival/departure at each station
                          </CardTitle>
                          <button onClick={() => setJobTraceExpanded(e => !e)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600 transition-colors text-xs font-medium">
                            <Expand className="w-3.5 h-3.5" /> Expand
                          </button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <JobTraceTable
                          result={displayRun.result ?? {}}
                          isExpanded={jobTraceExpanded}
                          onExpandToggle={() => setJobTraceExpanded(e => !e)}
                        />
                      </CardContent>
                    </Card>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {!displayRun && !isRunning && (
            <div className="text-center py-24 text-gray-400">
              <Play className="h-14 w-14 text-gray-200 mx-auto mb-4" />
              <p className="font-medium text-gray-500 mb-1">Click "Run Simulation" to start</p>
              <p className="text-sm text-gray-400">Charts and station breakdowns will appear here once a run completes</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
