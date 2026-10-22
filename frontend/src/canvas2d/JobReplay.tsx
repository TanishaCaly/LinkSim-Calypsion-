import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel, useStore } from 'reactflow'
import { jobPrefix } from '@/lib/variantColors'

/**
 * Build-mode job replay: plays a finished run's completion_log back on the
 * 2D Canvas. Each job is a circle that jumps box to box (Station 1 ->
 * Station 2 #2 -> End) at the times the engine recorded. Jobs waiting to move
 * on sit just right of the box they left. Each job shows its number in its
 * product's colour (variantColors), or its own colour when the product has
 * none; several jobs in one spot are drawn as one circle (the job leaving
 * next) with a count badge, so even long runs stay light to draw.
 */

/** A Canvas box a job can be shown at. */
export interface ReplayTarget {
  nodeId: string
  station: string     // stations_data key, e.g. "Station 2"
  machine: number     // parallel machine number (#1 -> 1); 1 for a single box
  isSource: boolean   // Start box — released jobs wait here for their first station
  isDrain: boolean    // End box — finished jobs collect here
}

interface Visit { station: string; machine: number; start: number; end: number }
/** One job: when it entered the line / finished its route (null if unknown / never), and its station visits. */
interface Job { num: number; color: string; release: number | null; finish: number | null; visits: Visit[] }

const SPEEDS = [1, 10, 30, 50, 100]
const CIRCLE = 30

// One colour per job, repeating after 16 — picked to stay distinct next to
// each other and readable under white text.
const JOB_COLORS = [
  '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16',
  '#f97316', '#6366f1', '#14b8a6', '#e11d48', '#0ea5e9', '#8b5cf6', '#ca8a04', '#10b981',
]

/** "productstart-012" -> 12, in its product's colour (byPrefix: job-id
 * prefix -> colour). Without one, each job gets its own colour; jobs of a
 * second variant get shifted colours so its job 1 doesn't look like the
 * first variant's job 1. */
function jobLook(id: string, variants: Map<string, number>, byPrefix: Record<string, string>): { num: number; color: string } {
  const m = id.match(/^(.*?)-?(\d+)$/)
  const prefix = m ? m[1] : id
  const num = m ? Number(m[2]) : 0
  if (byPrefix[prefix]) return { num, color: byPrefix[prefix] }
  if (!variants.has(prefix)) variants.set(prefix, variants.size)
  const shift = variants.get(prefix)! * 5
  return { num, color: JOB_COLORS[(Math.max(num, 1) - 1 + shift) % JOB_COLORS.length] }
}

/** "2025-01-01 06:02:00" -> minutes since the epoch (timezone-free). */
function toMinutes(stamp: unknown): number | null {
  if (typeof stamp !== 'string') return null
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
  return ms / 60000
}

/**
 * Each job's release/finish and station visits in time order, plus the
 * replay's start and length (min). releaseTimes/finishTimes are absent on
 * runs made before the engine recorded them — those jobs then just appear at
 * their first station and stay by their last one.
 */
function parseLog(
  log: Record<string, unknown[]>,
  releaseTimes: Record<string, unknown>,
  finishTimes: Record<string, unknown>,
  variantColors: Record<string, string>,
) {
  const jobs = new Map<string, Job>()
  const variants = new Map<string, number>()
  const byPrefix = Object.fromEntries(Object.entries(variantColors).map(([v, c]) => [jobPrefix(v), c]))
  const job = (id: string) => {
    if (!jobs.has(id)) jobs.set(id, { ...jobLook(id, variants, byPrefix), release: null, finish: null, visits: [] })
    return jobs.get(id)!
  }
  const stationOrder = Object.keys(log)
  let t0 = Infinity
  let tEnd = -Infinity
  const see = (t: number) => { t0 = Math.min(t0, t); tEnd = Math.max(tEnd, t) }
  for (const station of stationOrder) {
    for (const raw of log[station] as Record<string, unknown>[]) {
      const start = toMinutes(raw['process_start_time_real'])
      const end = toMinutes(raw['process_end_time_real'])
      const id = raw['job_id']
      if (start === null || end === null || typeof id !== 'string') continue
      const machine = typeof raw['machine'] === 'number' ? raw['machine'] : 1
      job(id).visits.push({ station, machine, start, end })
      see(start); see(end)
    }
  }
  for (const [id, stamp] of Object.entries(releaseTimes)) {
    const t = toMinutes(stamp)
    if (t !== null) { job(id).release = t; see(t) }
  }
  for (const [id, stamp] of Object.entries(finishTimes)) {
    const t = toMinutes(stamp)
    if (t !== null) { job(id).finish = t; see(t) }
  }
  if (t0 === Infinity) return { jobs: [] as Job[], t0: 0, total: 0 }
  // Ties (zero-time Start/Connector entries at the same instant as the next
  // station) fall back to flow order — the order stations first appear.
  const rank = new Map(stationOrder.map((s, i) => [s, i]))
  const list: Job[] = []
  for (const j of jobs.values()) {
    j.visits.sort((a, b) => a.start - b.start || a.end - b.end || rank.get(a.station)! - rank.get(b.station)!)
    list.push({
      num: j.num,
      color: j.color,
      release: j.release === null ? null : j.release - t0,
      finish: j.finish === null ? null : j.finish - t0,
      visits: j.visits.map((v) => ({ ...v, start: v.start - t0, end: v.end - t0 })),
    })
  }
  return { jobs: list, t0, total: tEnd - t0 }
}

function formatClock(t0: number, t: number): string {
  const d = new Date((t0 + t) * 60000)
  const day = Math.floor(t / 1440) + 1
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `Day ${day} · ${hh}:${mm}`
}

export default function JobReplay({ completionLog, releaseTimes, finishTimes, targets, variantColors }: {
  completionLog: Record<string, unknown[]>
  releaseTimes?: Record<string, unknown>
  finishTimes?: Record<string, unknown>
  targets: ReplayTarget[]
  // Product (variant) -> its colour, from the Start's MU table.
  variantColors?: Record<string, string>
}) {
  const { jobs, t0, total } = useMemo(
    () => parseLog(completionLog, releaseTimes ?? {}, finishTimes ?? {}, variantColors ?? {}),
    [completionLog, releaseTimes, finishTimes, variantColors],
  )

  const [time, setTime] = useState(0)          // simulated minutes since t0
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const timeRef = useRef(0)
  const speedRef = useRef(speed)
  speedRef.current = speed

  // A different run (or a re-run) starts over from the beginning.
  useEffect(() => { timeRef.current = 0; setTime(0); setPlaying(false) }, [completionLog])

  // Speed N = N simulated seconds per real second (same as the 3D view).
  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const next = Math.min(total, timeRef.current + ((now - last) / 1000) * speedRef.current / 60)
      last = now
      timeRef.current = next
      setTime(next)
      if (next >= total) { setPlaying(false); return }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, total])

  const nodeInternals = useStore((s) => s.nodeInternals)
  const [tx, ty, zoom] = useStore((s) => s.transform)

  // station|machine -> the box to draw at; a station's #1 box doubles as the
  // fallback for a run recorded before machine numbers existed.
  const byKey = useMemo(() => {
    const map = new Map<string, ReplayTarget>()
    for (const t of targets) map.set(`${t.station}|${t.machine}`, t)
    return map
  }, [targets])
  const source = useMemo(() => targets.find((t) => t.isSource), [targets])
  const drain = useMemo(() => targets.find((t) => t.isDrain), [targets])

  // Where every job is right now, grouped into one circle per spot. Each
  // spot shows the job that leaves it next (the log already knows when each
  // job moves on, so this follows FIFO/LIFO/Cyclic by itself); End shows the
  // job that finished last.
  const groups = useMemo(() => {
    interface Group { nodeId: string; after: boolean; count: number; job: Job; key: number; latest: boolean }
    const spots = new Map<string, Group>()
    // `leaves`: when this job moves on from the spot (End: when it got there).
    const add = (target: ReplayTarget | undefined, after: boolean, job: Job, leaves: number, latest = false) => {
      if (!target) return
      const id = `${target.nodeId}|${after}`
      const g = spots.get(id)
      if (!g) { spots.set(id, { nodeId: target.nodeId, after, count: 1, job, key: leaves, latest }); return }
      g.count++
      if (latest ? leaves > g.key : leaves < g.key) { g.job = job; g.key = leaves }
    }
    const find = (v: Visit) => byKey.get(`${v.station}|${v.machine}`) ?? byKey.get(`${v.station}|1`)
    for (const j of jobs) {
      const { release, finish, visits } = j
      const firstStart = visits[0]?.start ?? Infinity
      // The very first frame shows the starting point: every job released at
      // the start is still at Start, before the first moves of that same
      // minute (e.g. Job 1 into a free Station 1) happen.
      if (time <= 0 && source) {
        if (release !== null && release <= 0) add(source, true, j, firstStart)
        continue
      }
      if (finish !== null && time >= finish) { add(drain, false, j, finish, true); continue } // finished, at End
      if (!visits.length || time < firstStart) {
        // Released, waiting for its first station.
        if (release !== null && time >= release) add(source, true, j, firstStart)
        continue
      }
      let i = visits.length - 1
      while (i > 0 && visits[i].start > time) i--
      const v = visits[i]
      const target = find(v)
      const nextMove = visits[i + 1]?.start ?? finish ?? Infinity
      if (time < v.end) add(target, false, j, v.end)                                      // being worked on / riding
      else if (i === visits.length - 1 && target?.isDrain) add(target, false, j, v.end, true) // finished, at End
      else add(target, true, j, nextMove)                                                 // waiting to move on
    }
    return [...spots.values()]
  }, [jobs, time, byKey, source, drain])

  if (total <= 0) return null

  return (
    <>
      <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 5 }}>
        <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})`, transformOrigin: '0 0' }}>
          {groups.map((g) => {
            const n = nodeInternals.get(g.nodeId)
            if (!n?.positionAbsolute || !n.width || !n.height) return null
            const x = g.after ? n.positionAbsolute.x + n.width + 14 : n.positionAbsolute.x + n.width / 2
            const y = n.positionAbsolute.y + n.height / 2
            return (
              <div
                key={`${g.nodeId}|${g.after}`}
                className="absolute rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold tabular-nums leading-none"
                style={{ left: x - CIRCLE / 2, top: y - CIRCLE / 2, width: CIRCLE, height: CIRCLE, background: g.job.color, fontSize: g.job.num >= 1000 ? 9 : g.job.num >= 100 ? 10.5 : 12 }}
              >
                {g.job.num}
                {g.count > 1 && (
                  <span className="absolute -top-2.5 -right-3 min-w-[18px] h-[18px] px-1 rounded-full bg-gray-900 text-white text-[10px] font-bold leading-[18px] text-center tabular-nums">
                    {g.count}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <Panel position="bottom-center">
        <div className="flex items-center gap-2 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 px-4 py-2">
          <button
            onClick={() => {
              if (timeRef.current >= total) { timeRef.current = 0; setTime(0) }
              setPlaying((p) => !p)
            }}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium"
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            onClick={() => { setPlaying(false); timeRef.current = 0; setTime(0) }}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 font-medium"
          >
            ⏹ Stop
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`text-xs px-2 py-1.5 rounded-lg border font-medium transition-colors ${speed === s ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-blue-300'}`}
            >
              {s}×
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={total}
            step={total / 1000}
            value={time}
            onChange={(e) => { setPlaying(false); timeRef.current = Number(e.target.value); setTime(timeRef.current) }}
            className="w-40 accent-blue-600"
          />
          <span className="text-[10px] text-gray-500 font-medium whitespace-nowrap tabular-nums">
            {formatClock(t0, time)}
          </span>
        </div>
      </Panel>
    </>
  )
}
