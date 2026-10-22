import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts'
import {
  Play, RefreshCw, AlertTriangle, CheckCircle, Clock, ChevronRight, ChevronLeft,
  TrendingUp, Zap, Activity, Target, AlertCircle, BarChart2, Settings,
  CalendarDays, Layers, X, Lightbulb, Printer, Expand, Shrink, List, Search, Square, Timer,
} from 'lucide-react'
import { simulationsApi } from '@/api/simulations'
import type { SimConfigOverride } from '@/api/simulations'
import { scenariosApi } from '@/api/scenarios'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import type { RunDetail, StationStat, SimConfig } from '@/types'

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
  if (u >= 85) return '#ef4444'
  if (u >= 70) return '#f59e0b'
  if (u >= 40) return '#22c55e'
  return '#94a3b8'
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

function CompletedJobsCard({ completed, inProgress, scrapped, stats }: { completed: number; inProgress: number; scrapped: number; stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const sorted = [...stats].sort((a, b) => b.completed_jobs - a.completed_jobs)
  const maxJobs = sorted[0]?.completed_jobs || 1

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Completed Jobs</p>
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

function PeakUtilCard({ peakUtil, bottleneck, stats }: { peakUtil: number; bottleneck: StationStat | null; stats: StationStat[] }) {
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Peak Utilization</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{peakUtil.toFixed(1)}%</p>
              <p className="text-xs text-gray-400 mt-1">{bottleneck ? bottleneck.station_name : ''}</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50"><Activity className="h-4 w-4 text-blue-500" /></div>
          </div>
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
                const color = s.station_utilization >= 85 ? '#ef4444' : s.station_utilization >= 70 ? '#f59e0b' : '#22c55e'
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

function AvgUtilCard({ avgUtil, stats }: { avgUtil: number; stats: StationStat[] }) {
  const [open, setOpen] = useState(false)
  const sorted = [...stats].sort((a, b) => b.operator_utilization - a.operator_utilization)

  return (
    <div className="relative h-full">
      <Card className="border border-gray-200 cursor-pointer hover:border-blue-300 transition-colors h-full" onClick={() => setOpen(true)}>
        <CardContent className="pt-5 pb-4 h-full">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Station Util.</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{avgUtil.toFixed(1)}%</p>
              <p className="text-xs text-gray-400 mt-1">average across stations</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50"><Target className="h-4 w-4 text-blue-500" /></div>
          </div>
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
                const sColor = s.station_utilization >= 85 ? '#ef4444' : s.station_utilization >= 70 ? '#f59e0b' : '#22c55e'
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Setup Time</p>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Max Cycle Time</p>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Buffer Blocked</p>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Bottleneck Station</p>
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
            <div className="p-2 rounded-lg bg-blue-50 shrink-0"><Zap className="h-4 w-4 text-blue-500" /></div>
          </div>
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
                const color = s.station_utilization >= 85 ? '#ef4444' : s.station_utilization >= 70 ? '#f59e0b' : '#22c55e'
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

function ThroughputCard({ value, sub, stats }: { value: string; sub: string; stats: StationStat[] }) {
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Throughput</p>
              <p className="text-2xl font-bold text-gray-900 mt-1 leading-none">{value}</p>
              <p className="text-xs text-gray-400 mt-1">{sub}</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-50">
              <TrendingUp className="h-4 w-4 text-blue-500" />
            </div>
          </div>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Stations at Risk</p>
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
                const barColor = isBottleneck ? '#ef4444' : '#f59e0b'
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Total Failures</p>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">MTBF</p>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Availability</p>
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
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Sim Duration</p>
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

// ─── SimConfig dialog ─────────────────────────────────────────────────────────

const PRESETS = [
  { label: '1 Shift',  sub: '8 hours',   SIM_TIME: 480,    SHIFT_DURATION: 480 },
  { label: '1 Day',    sub: '24 hours',  SIM_TIME: 1440,   SHIFT_DURATION: 480 },
  { label: '1 Week',   sub: '7 days',    SIM_TIME: 10080,  SHIFT_DURATION: 480 },
  { label: '1 Month',  sub: '30 days',   SIM_TIME: 43200,  SHIFT_DURATION: 480 },
  { label: '1 Year',   sub: '365 days',  SIM_TIME: 525600, SHIFT_DURATION: 480 },
]

interface SimConfigDialogProps {
  open: boolean
  value: SimConfigOverride
  onChange: (v: SimConfigOverride) => void
  onClose: () => void
}

interface RunProgress { pct: number; msg: string; simTimeNow?: number; simTimeTotal?: number }

// Engine defaults from backend/parsers/yaml_parser.py — used whenever a
// scenario/override hasn't set its own SHIFT_n_START/END. Only covers the
// original fixed 3 — a 4th+ shift always has explicit hours set by whoever
// added it via "+ Add shift" (see addShift below), never a silent default.
const SHIFT_DEFAULTS: Record<number, { start: number; end: number }> = {
  1: { start: 6, end: 14 },
  2: { start: 14, end: 22 },
  3: { start: 22, end: 6 },
}

const CALENDAR_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function fmtHour(h: number): string {
  const hh = Math.floor(h) % 24
  const period = hh < 12 ? 'am' : 'pm'
  const display = hh % 12 === 0 ? 12 : hh % 12
  return `${display}${period}`
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h)

// Python weekday() numbering used by the backend: Monday=0 ... Sunday=6.
// Matches SimulationUtils.working_days' fallback when a shift has no
// explicit WORKING_DAYS_n set — Shift 1/2 default to Mon-Fri, Shift 3
// defaults to every day, same as the engine's original assumption. Any
// shift beyond the original 3 defaults to Mon-Fri, same as 1/2.
const DEFAULT_WORKING_DAYS: Record<number, number[]> = {
  1: [0, 1, 2, 3, 4],
  2: [0, 1, 2, 3, 4],
  3: [0, 1, 2, 3, 4, 5, 6],
}

interface BreakWindow { start: number; duration: number }

/** One shift's full editable config — an arbitrary-length array of these
 * replaces the old fixed Record<1|2|3, T> shape, so "+ Add shift" is just
 * pushing a new entry rather than a structural change. */
interface ShiftEntry {
  num: number
  name: string
  start: number
  end: number
  workingDays: number[]
  breaks: BreakWindow[]
}

// Matches backend/parsers/yaml_parser.py's _SIM_CONFIG_DEFAULTS — one
// default break per shift so a run has a realistic rest/lunch break out of
// the box, even before the user opens this dialog. A 4th+ shift gets no
// default break (empty), consistent with having no default hours either.
const DEFAULT_BREAKS: Record<number, BreakWindow[]> = {
  1: [{ start: 10, duration: 30 }],
  2: [{ start: 18, duration: 30 }],
  3: [{ start: 2, duration: 30 }],
}

/** Build the initial ShiftEntry[] from a SimConfigOverride, covering
 * whichever SHIFT_n_START keys are present (at least 3, or more if the
 * scenario was saved with extra shifts already). */
function shiftEntriesFromConfig(value: SimConfigOverride): ShiftEntry[] {
  let maxNum = 3
  for (let i = 4; value[`SHIFT_${i}_START`] != null; i++) maxNum = i
  return Array.from({ length: maxNum }, (_, i) => {
    const num = i + 1
    return {
      num,
      name: (value[`SHIFT_${num}_NAME`] as string | undefined) ?? '',
      start: (value[`SHIFT_${num}_START`] as number | undefined) ?? SHIFT_DEFAULTS[num]?.start ?? 8,
      end: (value[`SHIFT_${num}_END`] as number | undefined) ?? SHIFT_DEFAULTS[num]?.end ?? 16,
      workingDays: (value[`WORKING_DAYS_${num}`] as number[] | undefined) ?? DEFAULT_WORKING_DAYS[num] ?? [0, 1, 2, 3, 4],
      breaks: (value[`BREAKS_${num}`] as BreakWindow[] | undefined) ?? DEFAULT_BREAKS[num] ?? [],
    }
  })
}

/** Flatten ShiftEntry[] back into the SHIFT_n_START/WORKING_DAYS_n/BREAKS_n/
 * SHIFT_n_NAME keys the engine and rest of the app read. */
function shiftEntriesToConfig(shifts: ShiftEntry[]): Partial<SimConfigOverride> {
  const out: Record<string, unknown> = {}
  shifts.forEach(s => {
    out[`SHIFT_${s.num}_START`] = s.start
    out[`SHIFT_${s.num}_END`] = s.end
    out[`WORKING_DAYS_${s.num}`] = s.workingDays
    out[`BREAKS_${s.num}`] = s.breaks
    out[`SHIFT_${s.num}_NAME`] = s.name
  })
  return out
}

/**
 * Two shift-hour windows as (start, end) hour-of-day pairs, where end <= start
 * means the shift wraps past midnight (e.g. 22-6). Every window is expressed
 * as its "today" AND "tomorrow" occurrence on a 0-48 timeline — a plain
 * same-day shift (e.g. 2-4) still needs its tomorrow occurrence (26-28) to
 * correctly detect overlap against a wrapping shift that spills into the
 * next calendar day (e.g. 22-6, whose today-occurrence is 22-30). Returns
 * true if the two windows share ANY overlapping time.
 */
function hourWindowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const toIntervals = (start: number, end: number): [number, number][] => {
    const todayEnd = end <= start ? end + 24 : end
    return [[start, todayEnd], [start + 24, todayEnd + 24]]
  }
  const as = toIntervals(aStart, aEnd)
  const bs = toIntervals(bStart, bEnd)
  return as.some(([as1, ae1]) => bs.some(([bs1, be1]) => as1 < be1 && bs1 < ae1))
}

/**
 * Warnings for the Shift Calendar — non-blocking (Apply/Save always works
 * regardless; see the "warning only" decision this mirrors from elsewhere in
 * the app, e.g. Source/Drain). Flags five real misconfigurations:
 *
 *   1. Two shifts overlapping in time on a day both are actually active —
 *      e.g. Shift 1 6am-2pm and Shift 4 8am-4pm both running Monday means
 *      the same hours are double-covered, almost certainly not intended.
 *   2. A break scheduled outside its OWN shift's hours — it would never
 *      actually happen, since the engine only checks breaks while that
 *      shift is active.
 *   3. A shift with every day of the week unchecked — it will never run at
 *      all, silently, with nothing else in the UI explaining why.
 *   4. A shift whose start and end hour are identical — ambiguous: could
 *      mean "runs the full 24 hours" but is far more often a forgotten edit
 *      to the end-hour dropdown.
 *   5. A day of the week with zero shifts active across the WHOLE
 *      calendar — flagged only when at least one OTHER day does have
 *      coverage, so an intentionally fully-idle scenario (e.g. a paused
 *      line) doesn't get warned on every single day.
 *
 * Does NOT flag: a day with zero shifts when the whole week has no active
 * shifts anywhere (that's covered by #3 on every shift instead), or a
 * break that's merely long (already caught by #2 once it spills past the
 * shift's own end).
 */
function shiftCalendarWarnings(shifts: ShiftEntry[]): string[] {
  const warnings: string[] = []
  const dayLabel = (d: number) => CALENDAR_DAYS[d] ?? `Day ${d}`
  const shiftLabel = (s: ShiftEntry) => s.name.trim() || `Shift ${s.num}`

  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      const a = shifts[i]
      const b = shifts[j]
      if (!hourWindowsOverlap(a.start, a.end, b.start, b.end)) continue
      const sharedDays = a.workingDays.filter((d) => b.workingDays.includes(d))
      if (sharedDays.length === 0) continue
      warnings.push(`${shiftLabel(a)} and ${shiftLabel(b)} overlap on ${sharedDays.map(dayLabel).join(', ')}`)
    }
  }

  for (const s of shifts) {
    for (const bw of s.breaks) {
      const breakEnd = bw.start + bw.duration / 60
      if (!hourWindowsOverlap(s.start, s.end, bw.start, breakEnd)) {
        warnings.push(`${shiftLabel(s)}'s break is outside its own hours — it won't happen`)
      }
    }
  }

  for (const s of shifts) {
    if (s.workingDays.length === 0) {
      warnings.push(`${shiftLabel(s)} has no working days — it will never run`)
    }
  }

  for (const s of shifts) {
    if (s.start === s.end) {
      warnings.push(`${shiftLabel(s)} start and end time are the same`)
    }
  }

  const anyShiftHasAnyDay = shifts.some((s) => s.workingDays.length > 0)
  if (anyShiftHasAnyDay) {
    for (let d = 0; d < 7; d++) {
      const covered = shifts.some((s) => s.workingDays.includes(d))
      if (!covered) warnings.push(`No shift runs on ${dayLabel(d)}`)
    }
  }

  return warnings
}

/**
 * Editable weekly view of however many shifts this scenario uses (3 by
 * default, more via "+ Add shift"). Each shift has its own independent
 * working-days pattern — no shift is special-cased to always run every day.
 * Double-click a cell to toggle that shift on/off for that day. A station's
 * own "Shifts/Day" setting (Canvas Build panel) decides which of these
 * shifts it actually observes — 0/empty ignores this calendar entirely and
 * runs 24/7.
 */
function ShiftCalendar({
  shifts, onChange, onAddShift, onRemoveShift,
}: {
  shifts: ShiftEntry[]
  onChange: (num: number, patch: Partial<ShiftEntry>) => void
  onAddShift: () => void
  onRemoveShift: (num: number) => void
}) {
  const toggleDay = (num: number, dayIdx: number) => {
    const s = shifts.find(sh => sh.num === num)
    if (!s) return
    const days = s.workingDays
    onChange(num, { workingDays: days.includes(dayIdx) ? days.filter(d => d !== dayIdx) : [...days, dayIdx].sort() })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
          Shift Calendar
        </label>
        <button
          type="button"
          onClick={onAddShift}
          className="text-[11px] font-semibold text-blue-600 hover:text-blue-700"
        >
          + Add shift
        </button>
      </div>
      <div className="border border-gray-200 rounded-xl bg-gray-50 p-3">
        <div className="grid gap-1.5 items-center" style={{ gridTemplateColumns: '64px repeat(7, 1fr)' }}>
          <div />
          {CALENDAR_DAYS.map(d => (
            <div key={d} className="text-[10px] font-bold text-gray-400 text-center uppercase">{d}</div>
          ))}
          {shifts.map(s => (
            <FragmentRow
              key={s.num}
              name={s.name}
              shiftNum={s.num}
              onRename={name => onChange(s.num, { name })}
              color="bg-green-400"
              start={s.start}
              end={s.end}
              days={s.workingDays}
              onToggleDay={dayIdx => toggleDay(s.num, dayIdx)}
            />
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
          {shifts.map(s => (
            <div key={s.num} className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 font-medium w-16 shrink-0 truncate">{s.name.trim() || `Shift ${s.num}`}</span>
              <select
                value={s.start}
                onChange={e => onChange(s.num, { start: Number(e.target.value) })}
                className="h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
              >
                {HOUR_OPTIONS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
              <span className="text-xs text-gray-400">–</span>
              <select
                value={s.end}
                onChange={e => onChange(s.num, { end: Number(e.target.value) })}
                className="h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
              >
                {HOUR_OPTIONS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
              {shifts.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveShift(s.num)}
                  className="text-gray-300 hover:text-red-500 transition-colors ml-auto"
                  aria-label="Remove shift"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-gray-200 space-y-3">
          <p className="text-[11px] text-gray-500 font-medium">Breaks (e.g. lunch)</p>
          {shifts.map(s => (
            <div key={s.num} className="space-y-1.5">
              <span className="text-[11px] text-gray-500 font-medium">{s.name.trim() || `Shift ${s.num}`}</span>
              {s.breaks.map((bw, bi) => (
                <div key={bi} className="flex items-center gap-2 pl-2">
                  <select
                    value={bw.start}
                    onChange={e => {
                      const next = s.breaks.map((w, i) => i === bi ? { ...w, start: Number(e.target.value) } : w)
                      onChange(s.num, { breaks: next })
                    }}
                    className="h-7 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5"
                  >
                    {HOUR_OPTIONS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                  </select>
                  <span className="text-xs text-gray-400">for</span>
                  <BreakDurationInput
                    value={bw.duration}
                    onCommit={parsed => {
                      const next = s.breaks.map((w, i) => i === bi ? { ...w, duration: parsed } : w)
                      onChange(s.num, { breaks: next })
                    }}
                  />
                  <span className="text-xs text-gray-400">min</span>
                  <button
                    type="button"
                    onClick={() => onChange(s.num, { breaks: s.breaks.filter((_, i) => i !== bi) })}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-1"
                    aria-label="Remove break"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => onChange(s.num, { breaks: [...s.breaks, { start: 12, duration: 30 }] })}
                className="pl-2 text-[11px] font-medium text-blue-600 hover:text-blue-700"
              >
                + Add break
              </button>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-gray-400 mt-2.5 leading-relaxed">
          Double-click a day in the calendar to turn that shift on/off for that day — each shift keeps its own
          schedule. A station's own "Shift Available" setting decides which of these it uses.
        </p>
      </div>
    </div>
  )
}

/**
 * Break duration input as an uncontrolled-feeling text field: keeps its own
 * draft string while typing (so backspacing to empty actually works instead
 * of a controlled numeric value snapping back every keystroke), and only
 * commits a real number — clamped to >= 1 — on blur.
 */
function BreakDurationInput({ value, onCommit }: { value: number; onCommit: (parsed: number) => void }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => { setDraft(String(value)) }, [value])

  return (
    <input
      type="number"
      min={1}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        const parsed = Math.max(1, Number(draft) || 1)
        setDraft(String(parsed))
        onCommit(parsed)
      }}
      className="h-7 w-16 text-xs text-gray-800 bg-white border border-gray-200 rounded-md px-1.5 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
    />
  )
}

function FragmentRow({
  name, shiftNum, onRename, color, start, end, days, onToggleDay,
}: {
  name: string
  shiftNum: number
  onRename: (name: string) => void
  color: string
  start: number
  end: number
  days: number[]
  onToggleDay: (dayIdx: number) => void
}) {
  return (
    <>
      <input
        value={name}
        onChange={e => onRename(e.target.value)}
        placeholder={`Shift ${shiftNum}`}
        className="text-[11px] text-gray-700 font-medium h-7 w-full rounded-md border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-white bg-transparent px-1.5 transition-colors"
      />
      {CALENDAR_DAYS.map((d, i) => {
        const active = days.includes(i)
        return (
          <div key={d} className="relative group/cell">
            <div
              onDoubleClick={() => onToggleDay(i)}
              className={`h-6 rounded-md cursor-pointer select-none transition-colors ${active ? `${color} hover:brightness-95` : 'bg-gray-100 hover:bg-gray-200'}`}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-bottom transition-all duration-150 group-hover/cell:opacity-100 group-hover/cell:scale-100 z-30">
              {active ? `${fmtHour(start)}–${fmtHour(end)}` : 'Off'}
            </span>
          </div>
        )
      })}
    </>
  )
}

// ─── Simulation Timer dialog ──────────────────────────────────────────────────
// Separate, dedicated entry point for "when does the simulated clock start,
// and for how long does it run" — distinct from the general Simulation
// Config dialog's shift/breaks/working-days setup. Mirrors the run-timing
// pattern used by tools like Simio/FlexSim (a real start date/time + a run
// length), rather than bundling it into the broader config modal.

/** Format a Date as the value a <input type="datetime-local"> expects (local time, no timezone/seconds). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Custom dropdown calendar + time picker, styled to match the rest of the
 * app instead of relying on the browser's own tiny native calendar-icon
 * popup on <input type="datetime-local">. Value/onChange use the same
 * "YYYY-MM-DDTHH:mm" string shape as toDatetimeLocalValue so it's a drop-in
 * replacement wherever that native input was used.
 */
function DateTimePicker({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const parsed = value ? new Date(value) : new Date()
  const [viewMonth, setViewMonth] = useState(() => new Date(parsed.getFullYear(), parsed.getMonth(), 1))

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const selectDay = (day: number) => {
    const d = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day, parsed.getHours(), parsed.getMinutes())
    onChange(toDatetimeLocalValue(d))
  }

  const setTime = (hh: number, mm: number) => {
    const d = new Date(parsed)
    d.setHours(hh, mm)
    onChange(toDatetimeLocalValue(d))
  }

  const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate()
  // Monday-first grid: JS getDay() is Sunday=0, shift so Monday lands at column 0.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7
  const cells: (number | null)[] = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  const isSelectedDay = (day: number) =>
    parsed.getFullYear() === viewMonth.getFullYear() && parsed.getMonth() === viewMonth.getMonth() && parsed.getDate() === day
  const isToday = (day: number) => {
    const t = new Date()
    return t.getFullYear() === viewMonth.getFullYear() && t.getMonth() === viewMonth.getMonth() && t.getDate() === day
  }

  return (
    <div ref={wrapRef} className={`relative ${className ?? ''}`}>
      <div className="w-full h-10 flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 focus-within:bg-white focus-within:border-blue-400 transition-colors pl-3 pr-1.5">
        <button
          type="button"
          onClick={() => { setViewMonth(new Date(parsed.getFullYear(), parsed.getMonth(), 1)); setOpen(v => !v) }}
          className="flex items-center gap-2 text-sm text-gray-800 hover:text-blue-600 transition-colors"
        >
          <CalendarDays className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          {parsed.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}
        </button>
        <span className="text-gray-300">·</span>
        {/* Directly editable — no need to open the calendar dropdown just to
            nudge the time, which is the part users adjust most often. */}
        <input
          type="time"
          value={`${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`}
          onChange={(e) => {
            const [hh, mm] = e.target.value.split(':').map(Number)
            if (Number.isFinite(hh) && Number.isFinite(mm)) setTime(hh, mm)
          }}
          className="flex-1 min-w-0 h-full text-sm text-gray-800 bg-transparent focus:outline-none"
        />
      </div>

      {open && (
        <div className="absolute z-20 mt-1.5 w-72 bg-white rounded-xl border border-gray-200 shadow-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            ><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-semibold text-gray-800">
              {viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            ><ChevronRight className="h-4 w-4" /></button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
              <div key={d} className="text-center text-[10px] font-semibold text-gray-400 py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => (
              <button
                key={i}
                type="button"
                disabled={day === null}
                onClick={() => day && selectDay(day)}
                className={`h-8 rounded-lg text-xs transition-colors ${
                  day === null
                    ? ''
                    : isSelectedDay(day)
                      ? 'bg-blue-600 text-white font-semibold'
                      : isToday(day)
                        ? 'text-blue-600 font-semibold bg-blue-50 hover:bg-blue-100'
                        : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {day ?? ''}
              </button>
            ))}
          </div>

          <div className="flex justify-end mt-3 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 px-3 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SimTimerDialog({
  open, value, onChange, onClose, progress, onRun, isRunning, completionLog,
}: SimConfigDialogProps & { progress?: RunProgress | null; onRun?: (cfg: SimConfigOverride) => void; isRunning?: boolean; completionLog?: Record<string, unknown[]> | null }) {
  const [startDate, setStartDate] = useState(() =>
    value.SIMULATION_START_DATE ? String(value.SIMULATION_START_DATE).slice(0, 16) : toDatetimeLocalValue(new Date())
  )
  const [endDateStr, setEndDateStr] = useState(() => {
    const start = value.SIMULATION_START_DATE ? new Date(String(value.SIMULATION_START_DATE)) : new Date()
    const mins = value.SIM_TIME ?? 10080
    const d = new Date(start)
    d.setMinutes(d.getMinutes() + mins)
    return toDatetimeLocalValue(d)
  })
  const [activePreset, setActivePreset] = useState<number | null>(null)
  const [warmup, setWarmup] = useState(String(value.WARMUP_TIME ?? 0))

  // Replay controls for the last completed run's recorded timeline — the
  // backend runs SimPy as a single batch job with no live-pause capability,
  // so Reset/Play/Pause/speed here can only scrub an already-finished run's
  // completion_log, same mechanism as GanttTimeline/the 3D canvas use.
  const [replayPct, setReplayPct] = useState(0)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replaySpeed, setReplaySpeed] = useState<1 | 10 | 50>(10)
  const replaySpeedMap = { 1: 1, 10: 10, 50: 50 }

  const replayJobs = useMemo(() => {
    if (!completionLog) return []
    const rows: { start: number; end: number }[] = []
    for (const entries of Object.values(completionLog)) {
      for (const e of entries as Record<string, unknown>[]) {
        const startStr = e['process_start_time_real'] as string
        const endStr = e['process_end_time_real'] as string
        if (!startStr || !endStr) continue
        const start = new Date(startStr.replace(' ', 'T')).getTime()
        const end = new Date(endStr.replace(' ', 'T')).getTime()
        if (Number.isFinite(start) && Number.isFinite(end)) rows.push({ start, end })
      }
    }
    return rows
  }, [completionLog])

  const replayTMin = replayJobs.length > 0 ? Math.min(...replayJobs.map(j => j.start)) : 0
  const replayTMax = replayJobs.length > 0 ? Math.max(...replayJobs.map(j => j.end)) : 1
  const replayTotalMs = Math.max(1, replayTMax - replayTMin)
  const hasReplayData = replayJobs.length > 0

  useEffect(() => {
    // Reset scrub position whenever the underlying run data changes, so
    // reopening the dialog for a different run doesn't start mid-timeline.
    setReplayPct(0)
    setReplayPlaying(false)
  }, [completionLog])

  useEffect(() => {
    if (!replayPlaying) return
    let raf: number
    let last = performance.now()
    const tick = (now: number) => {
      const delta = now - last
      last = now
      const advanceMs = delta * replaySpeedMap[replaySpeed]
      setReplayPct(p => {
        const next = p + (advanceMs / replayTotalMs) * 100
        if (next >= 100) { setReplayPlaying(false); return 100 }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [replayPlaying, replaySpeed, replayTotalMs])

  const replayCutoffMs = replayTMin + (replayPct / 100) * replayTotalMs
  const replayElapsedMin = hasReplayData ? Math.round((replayCutoffMs - replayTMin) / 60000) : 0
  const replayTotalMin = hasReplayData ? Math.round(replayTotalMs / 60000) : 0

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  // Duration (minutes) is derived from the start/end gap — end date is the
  // source of truth here (AnyLogic-style), not a separately-tracked count.
  const durationMins = (() => {
    if (!startDate || !endDateStr) return null
    const mins = (new Date(endDateStr).getTime() - new Date(startDate).getTime()) / 60000
    return Number.isFinite(mins) && mins > 0 ? mins : null
  })()

  const applyPreset = (i: number, mins: number) => {
    setActivePreset(i)
    const d = new Date(startDate)
    d.setMinutes(d.getMinutes() + mins)
    setEndDateStr(toDatetimeLocalValue(d))
  }

  // Moving the start date shifts the end date by the same amount, preserving
  // whatever run length was already set instead of silently changing it.
  const shiftStartTo = (newStart: string) => {
    if (startDate && endDateStr) {
      const deltaMs = new Date(newStart).getTime() - new Date(startDate).getTime()
      if (Number.isFinite(deltaMs)) {
        setEndDateStr(toDatetimeLocalValue(new Date(new Date(endDateStr).getTime() + deltaMs)))
      }
    }
    setStartDate(newStart)
  }

  // Shift-1 window/working-days this override actually uses (falls back to
  // the same engine defaults SimConfigDialog uses), so the weekday check and
  // "snap to shift start" below reflect the real config, not a guess.
  const shift1Start = value.SHIFT_1_START ?? SHIFT_DEFAULTS[1].start
  const shift1WorkingDays = (value.WORKING_DAYS_1 as number[] | undefined) ?? DEFAULT_WORKING_DAYS[1]
  const shift1Name = (value.SHIFT_1_NAME as string | undefined)?.trim() || 'Shift 1'

  const startDateObj = startDate ? new Date(startDate) : null
  // JS getDay(): Sunday=0..Saturday=6 -> convert to Python-style Monday=0..Sunday=6
  // used by WORKING_DAYS_n, so this lines up with the engine's own weekday check.
  const startIsWorkingDay = startDateObj
    ? shift1WorkingDays.includes((startDateObj.getDay() + 6) % 7)
    : true

  /** Jump Start Date to the next moment Shift 1 is actually scheduled to run. */
  const snapToNextShiftStart = () => {
    const base = startDateObj ?? new Date()
    const d = new Date(base)
    d.setHours(Math.floor(shift1Start), Math.round((shift1Start % 1) * 60), 0, 0)
    if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1)
    for (let i = 0; i < 8; i++) {
      if (shift1WorkingDays.includes((d.getDay() + 6) % 7)) break
      d.setDate(d.getDate() + 1)
    }
    shiftStartTo(toDatetimeLocalValue(d))
  }

  const buildConfig = (): SimConfigOverride => ({
    ...value,
    SIMULATION_START_DATE: startDate ? `${startDate}:00` : undefined,
    SIM_TIME: durationMins ?? Number(value.SIM_TIME ?? 10080),
    WARMUP_TIME: Math.max(0, Number(warmup) || 0),
  })

  const apply = () => {
    onChange(buildConfig())
    onClose()
  }

  // Applies the config AND immediately triggers a run with it — passes the
  // freshly-built config directly to onRun rather than relying on onChange's
  // state update having landed yet (see triggerMutation's overrideCfg param).
  const applyAndRun = () => {
    const cfg = buildConfig()
    onChange(cfg)
    onRun?.(cfg)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] z-10 flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Clock className="h-4 w-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Simulation Timer</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-300 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-blue-400">

          {/* Live running-time readout while a run is in progress — mirrors the
              "Time" field Tecnomatix Plant Simulation shows at the top of its
              own event-controller dialog, fed from the same SSE progress state
              the header progress bar uses. */}
          {progress && progress.simTimeNow != null && progress.simTimeTotal != null && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-400 uppercase tracking-widest">Time</span>
              <span className="text-sm font-bold text-blue-900 tabular-nums">
                {progress.simTimeNow.toFixed(1)} / {progress.simTimeTotal.toFixed(1)} min
                <span className="text-blue-400 font-medium ml-2">({progress.pct.toFixed(0)}%)</span>
              </span>
            </div>
          )}

          {/* Replay controls for the last completed run's recorded timeline.
              The engine is a one-shot SimPy batch job — it can't be paused
              mid-computation — so these buttons scrub playback of a FINISHED
              run's completion_log rather than controlling a live simulation,
              the same model GanttTimeline/the 3D canvas already use. */}
          {!isRunning && hasReplayData && (
            <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Replay last run</span>
                <span className="text-[10px] text-gray-400 tabular-nums">{replayElapsedMin}m / {replayTotalMin}m</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title="Reset"
                  onClick={() => { setReplayPct(0); setReplayPlaying(false) }}
                  className="h-8 w-8 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 shrink-0"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={replayPlaying ? 'Pause' : 'Play'}
                  onClick={() => {
                    if (replayPct >= 100) setReplayPct(0)
                    setReplayPlaying(p => replayPct >= 100 ? true : !p)
                  }}
                  className="h-8 px-3 flex items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-xs font-semibold shrink-0"
                >
                  {replayPlaying ? '⏸ Pause' : '▶ Start'}
                </button>
                <button
                  type="button"
                  title="Stop"
                  onClick={() => setReplayPlaying(false)}
                  className="h-8 px-3 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 text-xs font-semibold shrink-0"
                >
                  ■ Stop
                </button>
                <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden shrink-0 ml-auto">
                  {([1, 10, 50] as const).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setReplaySpeed(s)}
                      className={`h-8 px-2.5 text-xs font-semibold transition-colors ${replaySpeed === s ? 'bg-blue-50 text-blue-700' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={replayPct}
                onChange={(e) => { setReplayPlaying(false); setReplayPct(Number(e.target.value)) }}
                className="w-full accent-blue-600"
              />
            </section>
          )}

          {/* Date range */}
          <section className="rounded-xl border border-gray-200 p-4 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Start Date &amp; Time</label>
                {startDateObj && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${startIsWorkingDay ? 'text-gray-500 bg-gray-100' : 'text-amber-600 bg-amber-50'}`}>
                    {startDateObj.toLocaleDateString(undefined, { weekday: 'long' })}
                    {!startIsWorkingDay && ' — non-working day'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <DateTimePicker value={startDate} onChange={shiftStartTo} className="flex-1" />
                <button
                  type="button"
                  onClick={() => shiftStartTo(toDatetimeLocalValue(new Date()))}
                  className="h-10 px-3 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-100 transition-colors whitespace-nowrap"
                >
                  Now
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5 gap-2">
                <p className="text-[10px] text-gray-400">
                  Anchors shift working-days (e.g. "Monday") to actual weekdays.
                </p>
                <button
                  type="button"
                  onClick={snapToNextShiftStart}
                  className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 whitespace-nowrap shrink-0"
                >
                  Snap to next {shift1Name} start
                </button>
              </div>
              {!startIsWorkingDay && (
                <p className="text-[10px] text-amber-600 mt-1">
                  {shift1Name} doesn't run on this weekday — the station will sit idle until its next working day.
                </p>
              )}
            </div>

            <div className="border-t border-gray-100 pt-4">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">End Date &amp; Time</label>
              <DateTimePicker
                value={endDateStr}
                onChange={(v) => { setEndDateStr(v); setActivePreset(null) }}
              />
              <p className="text-[10px] text-gray-400 mt-1.5">
                The real calendar date the simulated clock stops at. Run length is computed from the gap to Start Date.
              </p>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Quick Fill</p>
              <div className="grid grid-cols-5 gap-2">
                {PRESETS.map((p, i) => (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(i, p.SIM_TIME)}
                    className={`flex flex-col items-center py-3 rounded-xl border text-sm transition-all duration-150 ${
                      activePreset === i
                        ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                        : 'border-gray-100 bg-gray-50 hover:border-blue-200 hover:bg-blue-50/50 text-gray-600'
                    }`}
                  >
                    <span className="font-semibold text-sm">{p.label}</span>
                    <span className="text-[10px] text-gray-400 mt-0.5">{p.sub}</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">Sets End Date to Start Date + the chosen length. Edit End Date directly for anything else.</p>
            </div>
          </section>

          {/* Warm-up + summary */}
          <section className="rounded-xl border border-gray-200 p-4 space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">
                Warm-up Time (minutes)
              </label>
              <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 focus-within:border-blue-400 focus-within:bg-white transition-colors overflow-hidden">
                <button
                  type="button"
                  onClick={() => setWarmup(v => String(Math.max(0, Number(v) - 60)))}
                  className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
                >−</button>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, (durationMins ?? 0) - 60)}
                  value={warmup}
                  onChange={e => setWarmup(e.target.value)}
                  className="flex-1 text-center text-sm text-gray-900 bg-transparent focus:outline-none [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                />
                <button
                  type="button"
                  onClick={() => setWarmup(v => String(Math.min(Math.max(0, (durationMins ?? 0) - 60), Number(v) + 60)))}
                  className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
                >+</button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                {Number(warmup) > 0
                  ? `First ${(Number(warmup) / 60).toFixed(1)} hours excluded from utilization/throughput — lets the line fill up before measuring steady-state.`
                  : 'Off by default. Set a value to exclude the initial ramp-up period from KPIs.'}
              </p>
            </div>

            <div className="rounded-xl bg-blue-50 border border-blue-100 px-4 py-3">
              <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-widest mb-1">Simulated Period</p>
              {durationMins ? (
                <>
                  <p className="text-sm text-blue-900 font-medium">
                    {new Date(startDate).toLocaleString()} &rarr; {new Date(endDateStr).toLocaleString()}
                  </p>
                  <p className="text-[11px] text-blue-400 mt-1">
                    = {(durationMins / 60).toFixed(1)} hours · {(durationMins / 1440).toFixed(1)} days
                  </p>
                </>
              ) : (
                <p className="text-sm text-red-500 font-medium">End Date must be after Start Date.</p>
              )}
            </div>

            {/* Informational only — LinkSim's SimPy engine is event-driven and
                always jumps straight between scheduled events, so it already
                behaves as if this were on; there's no tick-based mode to
                disable it for. Shown checked/locked for parity with tools
                like Plant Simulation that expose it as a real toggle. */}
            <label className="flex items-center gap-2 text-xs text-gray-500 cursor-default select-none">
              <input type="checkbox" checked disabled className="h-3.5 w-3.5 rounded border-gray-300 accent-blue-400 opacity-80" />
              Skip long event intervals
              <span className="text-[10px] text-gray-400">(always on — engine is event-driven)</span>
            </label>
          </section>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={apply} disabled={!durationMins} variant="outline">Save Timer</Button>
          {onRun && (
            <Button
              size="sm"
              onClick={applyAndRun}
              disabled={!durationMins || isRunning}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isRunning ? 'Running…' : 'Save & Run'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function SimConfigDialog({ open, value, onChange, onClose }: SimConfigDialogProps) {
  const [custom, setCustom] = useState(String(value.SIM_TIME ?? 10080))
  const [reps, setReps] = useState(String(value.num_replications ?? 1))
  const [activePreset, setActivePreset] = useState<number | null>(null)
  // Arbitrary-length list of shift configs (hours, working days, breaks,
  // display name) — replaces the old fixed 1/2/3 Record shape so "+ Add
  // shift" is just pushing another entry, not a structural change.
  const [shifts, setShifts] = useState<ShiftEntry[]>(() => shiftEntriesFromConfig(value))

  // SimConfigDialog stays mounted permanently (only `open` toggles
  // visibility, see its render call in RunDashboard), so the useState
  // initializer above only ever runs once for the whole page's lifetime.
  // Without this, reopening the dialog after switching scenarios (or after
  // the scenario's saved shift names load in asynchronously) kept showing
  // whatever `shifts` was first computed from, not the current `value` —
  // which is why saved shift names appeared to "reset" to Shift 1/2/3.
  useEffect(() => {
    if (open) setShifts(shiftEntriesFromConfig(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Non-blocking — Apply always works regardless of these. Just flags
  // overlapping shift hours and breaks scheduled outside their own shift's
  // hours, both real (if easy to make) configuration mistakes.
  const calendarWarnings = useMemo(() => shiftCalendarWarnings(shifts), [shifts])

  const updateShift = (num: number, patch: Partial<ShiftEntry>) => {
    setShifts(prev => prev.map(s => s.num === num ? { ...s, ...patch } : s))
  }
  const addShift = () => {
    setShifts(prev => {
      const num = Math.max(...prev.map(s => s.num)) + 1
      // Matches every other shift's convention (see DEFAULT_BREAKS /
      // backend _SIM_CONFIG_DEFAULTS): one 30-min break roughly mid-shift,
      // so a newly added shift behaves realistically out of the box too.
      return [...prev, { num, name: '', start: 8, end: 16, workingDays: [0, 1, 2, 3, 4], breaks: [{ start: 12, duration: 30 }] }]
    })
  }
  const removeShift = (num: number) => {
    setShifts(prev => prev.length > 1 ? prev.filter(s => s.num !== num) : prev)
  }

  // Freeze the page behind the dialog — without this, the underlying
  // dashboard's own horizontal/vertical scrollbars stay live and visible
  // (and scrollable) while this modal is open.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prevOverflow }
  }, [open])

  if (!open) return null

  const apply = () => {
    onChange({
      ...value,
      SIM_TIME: Number(custom),
      num_replications: Math.max(1, Math.min(30, Number(reps) || 1)),
      // No Random Seed box any more — every run is random ("Auto").
      RANDOM_SEED: undefined,
      ...shiftEntriesToConfig(shifts),
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] z-10 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Settings className="h-4 w-4 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Simulation Config</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
          {/* Presets */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Duration Presets</p>
            <div className="grid grid-cols-5 gap-2">
              {PRESETS.map((p, i) => (
                <button
                  key={p.label}
                  onClick={() => { setActivePreset(i); setCustom(String(p.SIM_TIME)) }}
                  className={`flex flex-col items-center py-3 rounded-xl border text-sm transition-all duration-150 ${
                    activePreset === i
                      ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                      : 'border-gray-100 bg-gray-50 hover:border-blue-200 hover:bg-blue-50/50 text-gray-600'
                  }`}
                >
                  <span className="font-semibold text-sm">{p.label}</span>
                  <span className="text-[10px] text-gray-400 mt-0.5">{p.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Simulation Time */}
          <div>
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">
              Simulation Time (minutes)
            </label>
            <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 focus-within:border-blue-400 focus-within:bg-white transition-colors overflow-hidden">
              <button
                type="button"
                onClick={() => { setCustom(v => String(Math.max(60, Number(v) - 60))); setActivePreset(null) }}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >−</button>
              <input
                type="number"
                min={60}
                max={525600}
                value={custom}
                onChange={e => { setCustom(e.target.value); setActivePreset(null) }}
                className="flex-1 text-center text-sm text-gray-900 bg-transparent focus:outline-none [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
              <button
                type="button"
                onClick={() => { setCustom(v => String(Math.min(525600, Number(v) + 60))); setActivePreset(null) }}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >+</button>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              = {(Number(custom) / 60).toFixed(1)} hours · {(Number(custom) / 1440).toFixed(1)} days
            </p>
          </div>

          {/* Shift Calendar — editable view of however many shifts this run
              uses (3 by default, more via "+ Add shift"). Each shift has its
              own independent working-days pattern (double-click a cell to
              toggle), no shift is special-cased to always run every day.
              Each station's own "Shift Available" setting (Canvas Build
              panel) decides which of these shifts actually apply to it.
              Values shown fall back to the engine defaults (6am-2pm /
              2pm-10pm / 10pm-6am, Mon-Fri for Shift 1/2 and every day for
              Shift 3) when not yet configured. */}
          <ShiftCalendar
            shifts={shifts}
            onChange={updateShift}
            onAddShift={addShift}
            onRemoveShift={removeShift}
          />

          {/* Non-blocking — flags overlapping shift hours and breaks
              scheduled outside their own shift's hours. Save/Apply still
              works either way; this is just a heads-up. */}
          {calendarWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
              {calendarWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                  <span className="shrink-0">⚠</span>
                  <span>{w}</span>
                </p>
              ))}
            </div>
          )}

          {/* Replications */}
          <div>
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-widest block mb-2">
              Replications (1–30)
            </label>
            <div className="flex items-center border border-gray-200 rounded-xl bg-gray-50 focus-within:border-blue-400 focus-within:bg-white transition-colors overflow-hidden">
              <button
                type="button"
                onClick={() => setReps(v => String(Math.max(1, Number(v) - 1)))}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >−</button>
              <input
                type="number"
                min={1}
                max={30}
                value={reps}
                onChange={e => setReps(e.target.value)}
                className="flex-1 text-center text-sm text-gray-900 bg-transparent focus:outline-none [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
              />
              <button
                type="button"
                onClick={() => setReps(v => String(Math.min(30, Number(v) + 1)))}
                className="px-3 py-2.5 text-blue-500 hover:bg-blue-50 hover:text-blue-700 text-lg font-bold transition-colors select-none"
              >+</button>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">Multiple replications average results for statistical stability.</p>
          </div>

        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          <Button variant="outline" className="flex-1 rounded-xl border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600" onClick={onClose}>Cancel</Button>
          <Button className="flex-1 rounded-xl bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={apply}>Apply</Button>
        </div>
      </div>
    </div>
  )
}

// ─── Job Trace table ──────────────────────────────────────────────────────────

interface JobTraceRow {
  jobId: string
  station: string
  arrival: string | null
  departure: string | null
  windowMin: number | null
  waitingMin: number | null
  processingMin: number | null
  otherTimeMin: number | null
  totalMin: number | null
  status: string
  delayReason: string
}

function parseJobTrace(completionLog: Record<string, unknown[]>): JobTraceRow[] {
  const rows: JobTraceRow[] = []
  for (const [station, entries] of Object.entries(completionLog)) {
    for (const e of entries as Record<string, unknown>[]) {
      const jobId = (e['job_id'] as string) ?? '—'
      // process_start/end_time_real mark when this job actually started/finished
      // being WORKED ON at this station (after it already got the machine) —
      // NOT when it first arrived and began waiting in queue. So the window
      // between them is "Processing Time + Setup Time + Rework Time + any
      // shift-pause time falling inside it," not the job's full time at this
      // station. "Blocked Time" is the SEPARATE, prior queue-wait period
      // before the machine was acquired. Verified against real engine output:
      // one job's Blocked Time consistently equals the sum of the
      // process-window durations of jobs ahead of it in a single-server
      // queue. The true end-to-end time a job spends at a station is
      // Blocked Time + this window, not this window alone.
      const arrival = (e['process_start_time_real'] as string) ?? null
      const departure = (e['process_end_time_real'] as string) ?? null
      const status = (e['status'] as string) ?? (departure ? 'Completed' : 'In Progress')
      const delayReason = (e['delay_reason'] as string) ?? '—'
      // Round to 2dp rather than truncating to a whole number — station
      // durations imported from a spreadsheet are routinely fractional
      // (e.g. 4.39 min), and Math.round() was silently flattening those to
      // "4", losing real precision the user configured.
      const round2 = (n: number) => Math.round(n * 100) / 100
      const waitingMin = e['Blocked Time'] != null ? round2(Number(e['Blocked Time'])) : null
      const processingMin = e['Processing Time'] != null ? round2(Number(e['Processing Time'])) : null
      // What usually explains the gap between Processing (min) and Total
      // (min) below — Total counts the full process-window (see windowMin's
      // comment above), which silently folds in every OTHER delay signal
      // the backend tracks (sim_core.py's _determine_delay_reason draws
      // from these exact same fields to pick "Delay Reason"): machine
      // breakdown, waiting for an operator, material shortage, setup/
      // changeover, rework, and off-shift pause time (a job's station
      // acquired the machine, then sat paused overnight/weekend waiting for
      // the next shift). None of these had their own column before, so
      // Delay Reason could say e.g. "Waiting for material" while "Waiting
      // (min)" showed 0 in this same row — that column is queue-wait
      // (Blocked Time) only, a DIFFERENT signal from all six of these.
      // Summing them here means Waiting + Processing + this always accounts
      // for the Total a user sees, and it's built from the identical signal
      // set Delay Reason itself uses, so the two never disagree about what
      // actually happened to a job.
      const breakdownMin = e['station_downtime'] != null ? Number(e['station_downtime']) : 0
      const operatorMin = e['operators_downtime'] != null ? Number(e['operators_downtime']) : 0
      const materialMin = e['material_unavailability'] != null ? Number(e['material_unavailability']) : 0
      const setupMin = e['total_setup_time'] != null ? Number(e['total_setup_time']) : 0
      const reworkMin = e['total_rework_time'] != null ? Number(e['total_rework_time']) : 0
      const pauseMin = e['pause_time'] != null ? Number(e['pause_time']) : 0
      const otherTimeMin = round2(breakdownMin + operatorMin + materialMin + setupMin + reworkMin + pauseMin)
      let windowMin: number | null = null
      if (arrival && departure) {
        const start = new Date(arrival.replace(' ', 'T')).getTime()
        const end = new Date(departure.replace(' ', 'T')).getTime()
        windowMin = round2((end - start) / 60000)
      }
      // Total (min) used to be waitingMin + windowMin, where windowMin came
      // from subtracting two whole-second timestamp strings — losing
      // sub-second precision the backend's own numeric fields still have
      // (e.g. Processing Time 822.86 + pause_time 540 truly sums to
      // 1362.86, but the timestamp-derived window rounded to 1362.85).
      // Summing the precise numeric fields directly instead means Total
      // always exactly equals Waiting + Processing + Other Delay, with no
      // rounding drift between the two paths.
      const totalMin = waitingMin != null && processingMin != null
        ? round2(waitingMin + processingMin + otherTimeMin)
        : null
      rows.push({ jobId, station, arrival, departure, windowMin, waitingMin, processingMin, otherTimeMin, totalMin, status, delayReason })
    }
  }
  // Sort by arrival time (jobs with no arrival timestamp sink to the bottom)
  rows.sort((a, b) => {
    if (!a.arrival) return 1
    if (!b.arrival) return -1
    return a.arrival.localeCompare(b.arrival)
  })
  return rows
}

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
    ? { rowEven: '#1e293b', rowOdd: '#0f172a', grid: '#334155', legendBg: '#1e293b', label: '#e2e8f0', muted: '#94a3b8', barBorder: 'rgba(255,255,255,0.12)' }
    : { rowEven: '#f9fafb', rowOdd: '#ffffff', grid: '#e5e7eb', legendBg: '#f8fafc', label: '#374151', muted: '#9ca3af', barBorder: 'rgba(0,0,0,0.08)' }

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
            { color: '#22c55e', label: 'Processing' },
            { color: '#eab308', label: 'Waiting' },
            { color: '#ef4444', label: 'Blocked/Down' },
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
                {pw > 0 && <rect x={x1} y={y} width={pw} height={BAR_H} fill="#22c55e" rx={2} />}
                {/* Waiting segment — yellow */}
                {ww > 0 && <rect x={x1 + pw} y={y} width={ww} height={BAR_H} fill="#eab308" rx={0} />}
                {/* Blocked segment — red */}
                {bw > 0 && <rect x={x1 + pw + ww} y={y} width={bw} height={BAR_H} fill="#ef4444" rx={0} />}
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
              stroke="#1d4ed8" strokeWidth={1.5} strokeDasharray="4 3" />
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

function UtilTooltip({ active, payload, label }: { active?: boolean; payload?: {name: string; value: number; color: string}[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
            <span className="text-gray-500 text-xs">{p.name === 'station' ? 'Station' : 'Operator'}</span>
          </div>
          <span className="font-bold text-gray-800">{p.value}%</span>
        </div>
      ))}
    </div>
  )
}

function UtilisationChart({ stats }: { stats: StationStat[] }) {
  const isDark = useAppStore(s => s.theme) === 'dark'
  const gridStroke = isDark ? '#334155' : '#f0f0f0'
  const tickFill = isDark ? '#94a3b8' : '#666'
  const cursorFill = isDark ? '#1e293b' : '#f1f5f9'
  const data = [...stats]
    .sort((a, b) => b.station_utilization - a.station_utilization)
    .map((s) => ({
      name: s.station_name.length > 14 ? s.station_name.slice(0, 13) + '…' : s.station_name,
      station: parseFloat(s.station_utilization.toFixed(1)),
      operator: parseFloat(s.operator_utilization.toFixed(1)),
    }))
  // Scale chart width with station count so bars/labels stay readable instead
  // of squeezing to fit a fixed container when there are many stations.
  const chartWidth = Math.max(600, data.length * 44)

  return (
    <div className="overflow-x-auto [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
      <BarChart width={chartWidth} height={280} data={data} margin={{ top: 4, right: 16, left: -8, bottom: 30 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: tickFill }} angle={-35} textAnchor="end" interval={0} />
        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: tickFill }} />
        <Tooltip content={<UtilTooltip />} cursor={{ fill: cursorFill, radius: 4 }} />
        <Bar dataKey="station" name="station" fill={utilColor(0)} radius={[3, 3, 0, 0]} barSize={14}>
          {data.map((d, i) => <Cell key={i} fill={utilColor(d.station)} />)}
        </Bar>
        <Bar dataKey="operator" name="operator" fill="#93c5fd" radius={[3, 3, 0, 0]} barSize={14} />
      </BarChart>
    </div>
  )
}

function BottleneckChart({ stats }: { stats: StationStat[] }) {
  const isDark = useAppStore(s => s.theme) === 'dark'
  const gridStroke = isDark ? '#334155' : '#f0f0f0'
  const tickFill = isDark ? '#94a3b8' : '#666'
  const cursorFill = isDark ? '#1e293b' : '#f1f5f9'
  const top = [...stats].sort((a, b) => b.station_utilization - a.station_utilization)
  const data = top.map((s) => ({
    name: s.station_name.length > 14 ? s.station_name.slice(0, 13) + '…' : s.station_name,
    util: parseFloat(s.station_utilization.toFixed(1)),
  }))
  // Scale chart width with station count so bars/labels stay readable instead
  // of squeezing to fit a fixed container when there are many stations.
  const chartWidth = Math.max(600, data.length * 44)

  return (
    <div className="overflow-x-auto [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full">
      <BarChart width={chartWidth} height={280} data={data} margin={{ top: 4, right: 16, left: -8, bottom: 30 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: tickFill }} angle={-35} textAnchor="end" interval={0} />
        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: tickFill }} />
        <Tooltip
          cursor={{ fill: cursorFill }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const val = payload[0].value as number | undefined
            return (
              <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm">
                <p className="font-semibold text-gray-800 mb-1">{label}</p>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ background: payload[0].color }} />
                  <span className="text-gray-500 text-xs">Utilization</span>
                  <span className="font-bold text-gray-800 ml-2">{val ?? 0}%</span>
                </div>
              </div>
            )
          }}
        />
        <Bar dataKey="util" fill={utilColor(0)} radius={[3,3,0,0]} barSize={18}>
          {data.map((d, i) => <Cell key={i} fill={utilColor(d.util)} />)}
        </Bar>
      </BarChart>
    </div>
  )
}

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

function StationTable({ stats }: { stats: StationStat[] }) {
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
                className={`hover:bg-blue-50/40 transition-colors duration-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}
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

// ─── Run history sidebar ──────────────────────────────────────────────────────

function RunHistory({
  scenarioId, activeRunId, onSelect,
}: {
  scenarioId: number; activeRunId: number | null; onSelect: (r: RunDetail) => void
}) {
  const { data: runs = [] } = useQuery({
    queryKey: ['runs', scenarioId],
    queryFn: () => simulationsApi.listRuns(scenarioId),
    refetchInterval: 3000,
  })

  const statusDot: Record<string, string> = {
    completed: 'bg-green-400',
    running:   'bg-blue-400 animate-pulse',
    failed:    'bg-red-400',
    stopped:   'bg-red-400',
    pending:   'bg-gray-300',
  }

  return (
    <div className="space-y-1.5">
      {runs.map((r) => {
        const isActive = r.id === activeRunId
        return (
          <button
            key={r.id}
            onClick={() => {
              // The history list only carries lightweight KPI fields (no
              // station_stats/result) — fetch the full run detail so switching
              // to an older run shows its complete KPIs, station utilization,
              // and timeline, not just the summary numbers.
              simulationsApi.getRun(r.id).then(onSelect)
            }}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm transition-all duration-150 border ${
              isActive
                ? 'bg-blue-50 border-blue-300 text-blue-700 shadow-sm shadow-blue-100'
                : 'bg-white border-gray-100 hover:border-blue-200 hover:bg-blue-50/40 text-gray-600'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-2 h-2 rounded-full shrink-0 ${statusDot[r.status] ?? 'bg-gray-300'}`} />
              <div className="text-left">
                <p className={`text-xs font-semibold ${isActive ? 'text-blue-700' : 'text-gray-700'}`}>
                  Run #{r.id}
                </p>
                <p className={`text-[10px] capitalize ${
                  r.status === 'completed' ? 'text-green-500' :
                  r.status === 'running'   ? 'text-blue-400' :
                  r.status === 'failed'    ? 'text-red-400'  :
                  r.status === 'stopped'   ? 'text-red-400'  : 'text-gray-400'
                }`}>{r.status}</p>
              </div>
            </div>
            <ChevronRight className={`h-3 w-3 ${isActive ? 'text-blue-400' : 'text-gray-300'}`} />
          </button>
        )
      })}
      {runs.length === 0 && (
        <p className="text-xs text-gray-400 text-center py-4">No runs yet</p>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'kpis' | 'gantt' | 'jobtrace'

export default function RunDashboard() {
  const navigate = useNavigate()
  const { activeScenario, activeRun, setActiveRun, setActiveScenario, showToast, justReset, setJustReset } = useAppStore()
  const [displayRun, setDisplayRun] = useState<RunDetail | null>(activeRun)
  const [tab, setTab] = useState<Tab>('kpis')
  const [ganttExpanded, setGanttExpanded] = useState(false)
  const [jobTraceExpanded, setJobTraceExpanded] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [timerOpen, setTimerOpen] = useState(false)
  const [simCfg, setSimCfg] = useState<SimConfigOverride>({ SIM_TIME: 10080, num_replications: 1 })

  // Load whatever shift hours/working-days/breaks/names were last saved on
  // THIS scenario (e.g. from a previous Simulation Config session), instead
  // of always starting from the bare SIM_TIME/num_replications default —
  // otherwise reopening Simulation Config for a scenario with custom shift
  // names would show the generic "Shift 1/2/3" until re-typed.
  useEffect(() => {
    if (!activeScenario) return
    setSimCfg(cfg => ({ ...(activeScenario.simulation_config as SimConfigOverride ?? {}), ...cfg, SIM_TIME: cfg.SIM_TIME, num_replications: cfg.num_replications }))
  }, [activeScenario?.id])

  // Persist shift hours/working-days/breaks/names (and anything else in
  // Simulation Config) onto the scenario record itself, not just this
  // session's next-run override — so a rename made here is visible
  // everywhere the name is shown, including the Canvas Build panel, and
  // survives a reload/navigation instead of vanishing after one run.
  const persistSimConfig = async (next: SimConfigOverride) => {
    setSimCfg(next)
    if (!activeScenario) return
    try {
      const updated = await scenariosApi.update(activeScenario.id, {
        simulation_config: { ...(activeScenario.simulation_config ?? {}), ...next } as Partial<SimConfig>,
      })
      setActiveScenario(updated)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save simulation config', 'error')
    }
  }

  // Whenever the active scenario changes, load THAT scenario's own latest run
  // (or clear the display entirely if it has none) — otherwise the previously
  // viewed scenario's run stays on screen after switching scenarios.
  //
  // Skipped while justReset is set: this effect also re-fires on every fresh
  // mount of this page (not just on an actual scenario switch), since
  // activeScenario?.id is unchanged but the component itself is new — e.g.
  // navigating to View Flow and back to /run. Without this guard, Reset's
  // cleared KPIs would silently get re-populated a few seconds later once
  // this effect's fetch of "the scenario's latest run" resolved, since Reset
  // doesn't delete anything server-side — it only clears local state.
  useEffect(() => {
    if (justReset) return
    if (!activeScenario) { setDisplayRun(null); setActiveRun(null); return }
    let cancelled = false
    simulationsApi.listRuns(activeScenario.id).then((runs) => {
      if (cancelled) return
      if (runs.length === 0) { setDisplayRun(null); setActiveRun(null); return }
      // listRuns only returns lightweight KPI fields (no station_stats/result)
      // — fetch the full detail for the latest run so the dashboard shows
      // complete KPIs, station utilization, and timeline immediately.
      simulationsApi.getRun(runs[0].id).then((detail) => {
        if (cancelled) return
        setDisplayRun(detail)
        setActiveRun(detail)
      })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenario?.id, justReset])

  const [progress, setProgress] = useState<{ pct: number; msg: string; simTimeNow?: number; simTimeTotal?: number } | null>(null)
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const [historyWidth, setHistoryWidth] = useState(224) // matches the old fixed w-56
  const isResizingHistory = useRef(false)
  const esRef = useRef<EventSource | null>(null)
  // The run currently being streamed — the Stop button needs this id to
  // call stopRun(), and there's no other single place holding "the run
  // that's actively in progress right now" (activeRun/displayRun can also
  // point at a past, already-finished run selected from history).
  const runningRunIdRef = useRef<number | null>(null)
  // Bumped on every Reset click. In-flight async callbacks from a run that
  // was triggered before Reset (the SSE "done" handler, its onerror poll
  // retry, and the mutation's safety-net setTimeout below) capture the
  // token at schedule time and skip their setDisplayRun/setActiveRun calls
  // if it's gone stale — otherwise Reset only clears state for a moment
  // before one of these delayed callbacks quietly repopulates it (KPIs
  // looked reset, but View Flow's run overlay came back once the run's
  // "done" event or safety-net poll landed after the click).
  const resetTokenRef = useRef(0)

  // Drag-to-resize the run-history sidebar — mirrors a native panel splitter
  // instead of the old all-or-nothing collapse toggle. Tracks the delta from
  // drag-start rather than e.clientX directly, since this sidebar isn't at
  // the screen's left edge (the app nav sidebar sits to its left).
  const startHistoryResize = (e: React.MouseEvent) => {
    isResizingHistory.current = true
    const startX = e.clientX
    const startWidth = historyWidth
    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingHistory.current) return
      const next = Math.min(480, Math.max(160, startWidth + (ev.clientX - startX)))
      setHistoryWidth(next)
    }
    const onMouseUp = () => {
      isResizingHistory.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const stopStream = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
  }

  const startStream = (runId: number) => {
    stopStream()
    runningRunIdRef.current = runId
    const token = resetTokenRef.current
    const url = simulationsApi.streamUrl(runId)
    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data)
        if (evt.type === 'progress') {
          if (token !== resetTokenRef.current) return
          setProgress({ pct: evt.pct, msg: evt.msg, simTimeNow: evt.sim_time_now, simTimeTotal: evt.sim_time_total })
        } else if (evt.type === 'done' || evt.type === 'error') {
          runningRunIdRef.current = null
          if (token !== resetTokenRef.current) { stopStream(); return }
          setProgress(null)
          stopStream()
          // Fetch final run detail
          simulationsApi.getRun(runId).then((detail) => {
            if (token !== resetTokenRef.current) return
            setDisplayRun(detail)
            setActiveRun(detail)
            showToast(
              detail.status === 'completed'
                ? `Run #${runId} completed — ${detail.completed_jobs} jobs`
                : `Run #${runId} failed`,
              detail.status === 'completed' ? 'success' : 'error'
            )
          })
        }
      } catch { /* ignore */ }
    }

    es.onerror = () => {
      // SSE closed or server gone; fallback: poll once
      stopStream()
      if (token !== resetTokenRef.current) return
      simulationsApi.getRun(runId).then((detail) => {
        if (token !== resetTokenRef.current) return
        // Whatever the run's actual status, the live stream is gone — never
        // leave the "Queued…" banner stuck on screen after this point. A
        // fast-completing run can finish (and its progress_store entry get
        // cleaned up) before the EventSource even finishes connecting, so
        // "running" here just means "poll again shortly", not "keep waiting".
        setProgress(null)
        setDisplayRun(detail)
        setActiveRun(detail)
        if (detail.status === 'running') {
          setTimeout(() => startStream(runId), 500)
        }
      })
    }
  }

  const triggerMutation = useMutation({
    // Accepts an explicit config override so callers that just updated
    // simCfg (e.g. "Apply & Run" in the Simulation Timer) can pass the new
    // value directly, instead of racing React's async state update by
    // reading simCfg from closure right after calling its setter.
    mutationFn: (overrideCfg?: SimConfigOverride) => simulationsApi.triggerRun(activeScenario!.id, overrideCfg ?? simCfg),
    onSuccess: (data) => {
      showToast('Simulation started')
      setProgress({ pct: 0, msg: 'Queued…' })
      setJustReset(false)
      startStream(data.id)
      const token = resetTokenRef.current
      // Safety net: a small/fast scenario can finish (and its progress_store
      // entry get cleaned up) before the EventSource even finishes
      // connecting, so the "done" SSE event is never seen and the banner
      // gets stuck at "Queued…" forever. Back this up with a direct poll —
      // if the run is already done by the time this fires, clear the
      // banner and show the result even if SSE missed it.
      setTimeout(() => {
        if (token !== resetTokenRef.current) return
        simulationsApi.getRun(data.id).then((detail) => {
          if (token !== resetTokenRef.current) return
          if (detail.status !== 'running' && detail.status !== 'pending') {
            stopStream()
            setProgress(null)
            setDisplayRun(detail)
            setActiveRun(detail)
          }
        })
      }, 1500)
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const stopMutation = useMutation({
    mutationFn: (runId: number) => simulationsApi.stopRun(runId),
    onSuccess: () => showToast('Stop requested — finishing current step…'),
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  useEffect(() => { return stopStream }, [])

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
  const isRunning = !!progress || triggerMutation.isPending

  // KPIs — all pre-calculated by backend
  const simTime = displayRun?.simulation_time ?? 0
  const completedJobs = displayRun?.completed_jobs ?? 0
  const inProgressJobs = displayRun?.in_progress_jobs ?? 0
  const scrappedJobs = Number((displayRun?.result?.simulation_state as { scrapped_jobs?: number } | undefined)?.scrapped_jobs ?? 0)
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

  return (
    <>
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
        onRun={(cfg) => triggerMutation.mutate(cfg)}
        isRunning={isRunning}
        completionLog={displayRun?.result?.completion_log as Record<string, unknown[]> | undefined}
      />

      <div className="flex h-full">
        {/* Sidebar */}
        <aside
          className={`no-print relative border-r border-gray-100 bg-white flex flex-col shadow-sm ${historyCollapsed ? 'w-10' : ''}`}
          style={historyCollapsed ? undefined : { width: historyWidth }}
        >
          {/* Collapse toggle */}
          <button
            onClick={() => setHistoryCollapsed(c => !c)}
            className="group/toggle absolute -right-3 top-5 w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors z-30"
          >
            {historyCollapsed
              ? <ChevronRight className="h-3 w-3 text-gray-500" />
              : <ChevronLeft className="h-3 w-3 text-gray-500" />
            }
            <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-left transition-all duration-150 group-hover/toggle:opacity-100 group-hover/toggle:scale-100 z-30">
              {historyCollapsed ? 'Expand run history' : 'Collapse run history'}
            </span>
          </button>

          {/* Drag-to-resize handle — starts below the collapse button so the
              two controls never share a hit-area. */}
          {!historyCollapsed && (
            <div
              onMouseDown={startHistoryResize}
              draggable={false}
              className="absolute -right-1.5 top-12 bottom-0 w-3 cursor-col-resize z-20 select-none flex justify-center group/handle"
            >
              <div className="w-1 h-10 mt-4 rounded-full bg-gray-200 group-hover/handle:bg-blue-300 transition-colors" />
              <span className="pointer-events-none absolute left-full ml-2 top-4 whitespace-nowrap rounded-lg bg-white text-gray-700 text-xs font-medium px-3 py-2 shadow-lg border border-gray-100 opacity-0 scale-95 origin-left transition-all duration-150 group-hover/handle:opacity-100 group-hover/handle:scale-100 z-30">
                Drag to resize
              </span>
            </div>
          )}

          {!historyCollapsed && (<>
            {/* Header */}
            <div className="px-4 pt-5 pb-3 border-b border-gray-100">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">What If</p>
            </div>

            {/* Runs list */}
            <div className="flex-1 overflow-auto p-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-gray-50 [&::-webkit-scrollbar-thumb]:bg-blue-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-blue-300">
              <RunHistory
                scenarioId={activeScenario.id}
                activeRunId={displayRun?.id ?? null}
                onSelect={(r) => {
                  // Switching to a different run (e.g. an older completed one)
                  // must never leave a previous run's "Queued…" banner or SSE
                  // connection alive on screen.
                  stopStream()
                  setProgress(null)
                  setDisplayRun(r)
                  setActiveRun(r)
                  setJustReset(false)
                }}
              />
            </div>

            {/* Legend */}
            <div className="p-4 border-t border-gray-100 space-y-2">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Legend</p>
              {[
                { color: 'bg-green-400', label: 'Healthy (40–69%)' },
                { color: 'bg-amber-400', label: 'High load (70–84%)' },
                { color: 'bg-red-400',   label: 'Bottleneck (≥85%)' },
              ].map(({ color, label }) => (
                <div key={label} className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${color}`} />
                  <span className="text-xs text-gray-500">{label}</span>
                </div>
              ))}
            </div>
          </>)}
        </aside>

        {/* Main */}
        <div className="print-main flex-1 min-w-0 p-6 overflow-auto bg-gradient-to-br from-white via-blue-50/30 to-indigo-50/40">
          {/* Header */}
          <div className="print:hidden flex items-center justify-between flex-wrap gap-3 mb-5 max-w-full">
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
            <div className="flex gap-2 flex-wrap justify-end">
              <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
                <Settings className="h-4 w-4 mr-1.5" />
                Config
              </Button>
              <Button variant="outline" size="sm" onClick={() => setTimerOpen(true)}>
                <Clock className="h-4 w-4 mr-1.5" />
                Simulation Timer
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Clear the run — KPIs go to 0 and View Flow opens a blank Build canvas"
                onClick={() => {
                  resetTokenRef.current += 1
                  stopStream()
                  setProgress(null)
                  setDisplayRun(null)
                  setActiveRun(null)
                  setJustReset(true)
                  setSimCfg({ SIM_TIME: 10080, num_replications: 1 })
                  showToast('Reset — showing no run')
                }}
              >
                <RefreshCw className="h-4 w-4 mr-1.5" />
                Reset
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate('/canvas')}>
                <BarChart2 className="h-4 w-4 mr-1.5" />
                View Flow
              </Button>
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
                  onClick={() => {
                    const runId = runningRunIdRef.current ?? displayRun?.id
                    if (runId != null) stopMutation.mutate(runId)
                  }}
                  disabled={stopMutation.isPending || (runningRunIdRef.current == null && displayRun?.id == null)}
                  className="border-red-200 text-red-600 hover:bg-red-50 rounded-lg"
                  title="Stop this run at its next checkpoint — partial results up to that point are kept"
                >
                  <Square className="h-4 w-4 mr-1.5" />
                  {stopMutation.isPending ? 'Stopping…' : 'Stop'}
                </Button>
              )}
              <Button size="sm" onClick={() => triggerMutation.mutate()} disabled={isRunning} className="bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm">
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
              {displayRun.status === 'completed' && (
                <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    onClick={() => setTab('kpis')}
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'kpis' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    <Layers className="h-3.5 w-3.5 inline mr-1" />KPIs
                  </button>
                  <button
                    onClick={() => setTab('gantt')}
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'gantt' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    <CalendarDays className="h-3.5 w-3.5 inline mr-1" />Timeline
                  </button>
                  <button
                    onClick={() => setTab('jobtrace')}
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'jobtrace' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    <List className="h-3.5 w-3.5 inline mr-1" />Job Trace
                  </button>
                </div>
              )}
            </div>
          )}

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
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 auto-rows-fr">
                <CompletedJobsCard completed={completedJobs} inProgress={inProgressJobs} scrapped={scrappedJobs} stats={stats} />
                <ThroughputCard value={`${throughput} /hr`} sub="jobs per hour" stats={stats} />
                <SimDurationCard simDays={simDays} simTime={simTime} simCfg={simCfg} />
                <PeakUtilCard peakUtil={peakUtil} bottleneck={bottleneck} stats={stats} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 auto-rows-fr">
                <AvgUtilCard avgUtil={avgUtil} stats={stats} />
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
              </div>
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
                  {tab === 'kpis' && (
                    <>
                      {Object.keys(activeScenario.variant_intervals ?? {}).length > 0 && (
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
                                  <div key={variant} className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-100 bg-gradient-to-br from-violet-50/60 to-purple-50/40 min-w-[180px]">
                                    <div className="p-2 rounded-lg bg-violet-100 shrink-0">
                                      <CalendarDays className="h-4 w-4 text-violet-500" />
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-gray-800 truncate">{variant}</p>
                                      <p className="text-xs text-gray-400 mt-0.5">{qty} jobs</p>
                                      <p className="text-xs font-bold mt-0.5" style={{ color: interval ? '#7c3aed' : '#9ca3af' }}>
                                        {interval ? `every ${interval} min` : 'all at once'}
                                      </p>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </CardContent>
                        </Card>
                      )}

                      {stats.length > 0 && (
                        <>
                          <Card className="mb-5">
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm font-semibold text-gray-700">Station Health Overview</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <StationHealthGrid stats={stats} />
                            </CardContent>
                          </Card>

                          <div className="flex flex-col gap-5 mb-5">
                            <Card>
                              <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                  <CardTitle className="text-sm font-semibold text-gray-700">Station & Operator Utilization</CardTitle>
                                  <div className="flex items-center gap-3 text-xs text-gray-400">
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm inline-block bg-green-400" /> Station</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm inline-block bg-blue-200" /> Operator</span>
                                  </div>
                                </div>
                              </CardHeader>
                              <CardContent>
                                <UtilisationChart stats={stats} />
                              </CardContent>
                            </Card>
                            <Card>
                              <CardHeader className="pb-4">
                                <div className="flex items-center justify-between">
                                  <CardTitle className="text-sm font-semibold text-gray-700">Top Bottlenecks</CardTitle>
                                  <span className="text-xs text-gray-400">Sorted by utilization</span>
                                </div>
                              </CardHeader>
                              <CardContent>
                                <BottleneckChart stats={stats} />
                              </CardContent>
                            </Card>
                          </div>

                          <Card>
                            <CardHeader className="pb-2">
                              <div className="flex items-center justify-between">
                                <CardTitle className="text-sm font-semibold text-gray-700">Station Details</CardTitle>
                                <button
                                  onClick={() => navigate('/insights')}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-xs font-semibold shadow-sm hover:shadow-blue-200 hover:shadow-md transition-all"
                                >
                                  <Lightbulb className="h-3 w-3" />
                                  AI Insights
                                </button>
                              </div>
                            </CardHeader>
                            <CardContent>
                              <StationTable stats={stats} />
                            </CardContent>
                          </Card>
                        </>
                      )}
                    </>
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
                        <GanttTimeline result={displayRun.result ?? {}} simTime={displayRun.simulation_time} isExpanded={ganttExpanded} onExpandToggle={() => setGanttExpanded(e => !e)} />
                      </CardContent>
                    </Card>
                  )}

                  {tab === 'jobtrace' && (
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
