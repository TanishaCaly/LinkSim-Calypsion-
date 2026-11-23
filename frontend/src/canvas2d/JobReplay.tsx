import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Panel, useStore } from 'reactflow'
import { jobPrefix } from '@/lib/variantColors'
import ReplayBar, { DEFAULT_REPLAY_SPEED, IdleReplayBar, REPLAY_SPEEDS, fmtReplayClock } from '@/components/run/ReplayBar'
import SimSettingsMenu, { openSimDialog } from '@/components/run/SimSettingsMenu'

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
  products?: string[] // Start box: job-id prefixes of the products it releases
}

// `work`: when work on it started (a main part sat on an Assembly waiting
// for its parts from `start` until then). `part`: it waits there as a part.
// `piece`: a Dismantle piece, waiting on the Dismantle for its next station.
interface Visit { station: string; machine: number; start: number; work: number; end: number; part?: boolean; piece?: boolean }
/**
 * One job: when it entered the line / finished its route (null if unknown /
 * never), and its station visits. Assembly: `gone` — when it disappears into
 * an assembly (a part, or the main part of a New FE); `mix` — from when it's
 * drawn in slices, one colour per part type attached.
 */
interface Job {
  id: string; num: number; prefix: string; color: string; release: number | null; finish: number | null; visits: Visit[]
  gone: number | null; mix: { from: number; colors: string[] } | null
  // Attach all parts: the main part and the parts in it (from mix.from).
  // A Dismantle piece: the job it came from.
  madeFrom: string[] | null
}

/** An assembly made in the run (simulation_state.assemblies, keyed by the job that leaves). */
export interface AssemblyRecord { station: string; main: string; mode: string; parts: string[] }

/** A job dismantled in the run (simulation_state.dismantles, keyed by that job): its pieces, one per next station. */
export interface DismantleRecord { station: string; mode: string; pieces: string[] }

const CIRCLE = 30
// Hover card: at most this many jobs listed (the rest counted).
const MAX_LISTED = 200

/** Where a job is shown at a moment, and what it's doing there. */
// `rank`: which job the circle shows (the lowest; End: the highest).
interface Place { target: ReplayTarget; after: boolean; came: number; leaves: number; rank: number; latest: boolean; status: string }
const spotId = (p: Place) => `${p.target.nodeId}|${p.after}`

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
function jobLook(id: string, variants: Map<string, number>, byPrefix: Record<string, string>): { num: number; prefix: string; color: string } {
  const m = id.match(/^(.*?)-?(\d+)$/)
  const prefix = m ? m[1] : id
  const num = m ? Number(m[2]) : 0
  if (byPrefix[prefix]) return { num, prefix, color: byPrefix[prefix] }
  if (!variants.has(prefix)) variants.set(prefix, variants.size)
  const shift = variants.get(prefix)! * 5
  return { num, prefix, color: JOB_COLORS[(Math.max(num, 1) - 1 + shift) % JOB_COLORS.length] }
}

/** "2025-01-01 06:02:00" -> minutes since the epoch (timezone-free). */
// The log's wall-clock time (parsed above as if it were UTC) as an ordinary local date, so the shared replay
// bar, which reads local time like the 3D view, shows the same hours.
function wallMs(minutes: number): number {
  const d = new Date(minutes * 60000)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime()
}

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
  assemblies: Record<string, AssemblyRecord>,
  dismantles: Record<string, DismantleRecord>,
) {
  const jobs = new Map<string, Job>()
  const variants = new Map<string, number>()
  const byPrefix = Object.fromEntries(Object.entries(variantColors).map(([v, c]) => [jobPrefix(v), c]))
  const job = (id: string) => {
    if (!jobs.has(id)) {
      jobs.set(id, {
        id, ...jobLook(id, variants, byPrefix), release: null, finish: null, visits: [],
        gone: null, mix: null, madeFrom: null,
      })
    }
    return jobs.get(id)!
  }
  const stationOrder = Object.keys(log)
  let t0 = Infinity
  let tEnd = -Infinity
  const see = (t: number) => { t0 = Math.min(t0, t); tEnd = Math.max(tEnd, t) }
  for (const station of stationOrder) {
    for (const raw of log[station] as Record<string, unknown>[]) {
      const logged = toMinutes(raw['process_start_time_real'])
      const end = toMinutes(raw['process_end_time_real'])
      const id = raw['job_id']
      if (logged === null || end === null || typeof id !== 'string') continue
      // A main part sat on the Assembly waiting for its parts before that.
      const partsWait = raw['Waiting for parts']
      const start = typeof partsWait === 'number' ? logged - partsWait : logged
      const machine = typeof raw['machine'] === 'number' ? raw['machine'] : 1
      job(id).visits.push({ station, machine, start, work: logged, end })
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
  // Assemblies: the parts wait on the Assembly until it finishes, then go —
  // into the main part, or, with a New FE, the main part goes too and the
  // New FE leaves from there. Attached items are drawn in slices.
  for (const [out, rec] of Object.entries(assemblies)) {
    const main = jobs.get(rec.main)
    if (!main) continue
    const partVisits = rec.parts.map((id) => {
      const p = jobs.get(id)
      const at = p?.visits.filter((v) => v.station === rec.station) ?? []
      return { p, v: at.reduce<Visit | undefined>((last, v) => (!last || v.start > last.start ? v : last), undefined) }
    })
    const joined = Math.max(-Infinity, ...partVisits.map(({ v }) => v?.end ?? -Infinity))
    const done = main.visits
      .filter((v) => v.station === rec.station && v.end >= joined)
      .reduce<Visit | undefined>((first, v) => (!first || v.end < first.end ? v : first), undefined)
    if (!done) continue
    for (const { p, v } of partVisits) {
      if (!p || !v) continue
      v.end = done.end
      v.part = true
      p.gone = done.end
    }
    if (out !== rec.main) {
      main.gone = done.end
      const made = job(out)
      // A renumbered Main FE (a-A001): still the main part's product.
      if (out.startsWith(`${main.prefix}-A`)) { made.prefix = main.prefix; made.color = main.color }
      made.visits.push({ station: rec.station, machine: done.machine, start: done.end, work: done.end, end: done.end })
    }
    if (rec.mode === 'attach') {
      // One slice per part type (product), in its colour; main part first.
      const colors = new Map<string, string>()
      for (const id of [rec.main, ...rec.parts]) {
        const j = jobs.get(id)
        if (j && !colors.has(j.prefix)) colors.set(j.prefix, j.color)
      }
      job(out).mix = { from: done.end, colors: [...colors.values()] }
      job(out).madeFrom = [rec.main, ...rec.parts]
    }
  }
  // Dismantles: the job disappears when the Dismantle finishes it; its
  // pieces leave from there in its colour, each waiting on the Dismantle
  // until its next station takes it.
  for (const [id, rec] of Object.entries(dismantles)) {
    const whole = jobs.get(id)
    const done = whole?.visits
      .filter((v) => v.station === rec.station)
      .reduce<Visit | undefined>((last, v) => (!last || v.start > last.start ? v : last), undefined)
    if (!whole || !done) continue
    if (!rec.pieces.includes(id)) whole.gone = done.end
    for (const pid of rec.pieces) {
      const p = job(pid)
      if (pid !== id) {
        p.color = whole.color
        p.mix = whole.mix && { from: done.end, colors: whole.mix.colors }
        p.madeFrom = [id]
        // Every piece shows the number of the job it came from (job 1's
        // pieces: 1 and 1). Detach FE (Car-001-2): its product too.
        p.num = whole.num
        if (pid.startsWith(`${id}-`)) p.prefix = whole.prefix
      }
      const next = Math.min(Infinity, ...p.visits.filter((v) => v !== done && v.start >= done.end).map((v) => v.start))
      const leaves = Number.isFinite(next) ? next : p.finish ?? Infinity
      if (leaves > done.end) {
        p.visits.push({ station: rec.station, machine: done.machine, start: done.end, work: done.end, end: leaves, piece: true })
      }
    }
  }
  if (t0 === Infinity) return { jobs: [] as Job[], t0: 0, total: 0 }
  // Ties (zero-time Start/Connector entries at the same instant as the next
  // station) fall back to flow order — the order stations first appear.
  const rank = new Map(stationOrder.map((s, i) => [s, i]))
  const list: Job[] = []
  for (const j of jobs.values()) {
    j.visits.sort((a, b) => a.start - b.start || a.end - b.end || rank.get(a.station)! - rank.get(b.station)!)
    list.push({
      id: j.id,
      num: j.num,
      prefix: j.prefix,
      color: j.color,
      release: j.release === null ? null : j.release - t0,
      finish: j.finish === null ? null : j.finish - t0,
      visits: j.visits.map((v) => ({ ...v, start: v.start - t0, work: v.work - t0, end: v.end - t0 })),
      gone: j.gone === null ? null : j.gone - t0,
      mix: j.mix && { from: j.mix.from - t0, colors: j.mix.colors },
      madeFrom: j.madeFrom,
    })
  }
  return { jobs: list, t0, total: tEnd - t0 }
}

export default function JobReplay({ completionLog, releaseTimes, finishTimes, assemblies, dismantles, targets, variantColors, runMinutes, runControls }: {
  completionLog: Record<string, unknown[]>
  releaseTimes?: Record<string, unknown>
  finishTimes?: Record<string, unknown>
  // Absent on runs made before Assemblies joined parts.
  assemblies?: Record<string, AssemblyRecord>
  // Absent on runs made before Dismantles made pieces.
  dismantles?: Record<string, DismantleRecord>
  targets: ReplayTarget[]
  // Product (variant) -> its colour, from the Start's MU table.
  variantColors?: Record<string, string>
  // How long the run was set to simulate, in minutes; the replay bar shows it as "Run for".
  runMinutes?: number
  // Run (and Stop while running), at the right end of the replay bar next to Sim setting.
  runControls?: ReactNode
}) {
  const { jobs, t0, total: lastMove } = useMemo(
    () => parseLog(completionLog, releaseTimes ?? {}, finishTimes ?? {}, variantColors ?? {}, assemblies ?? {}, dismantles ?? {}),
    [completionLog, releaseTimes, finishTimes, variantColors, assemblies, dismantles],
  )
  // The replay plays to the end of the run, even when the last job moved earlier.
  const total = lastMove > 0 ? Math.max(lastMove, runMinutes ?? 0) : 0

  const [time, setTime] = useState(0)          // simulated minutes since t0
  const [playing, setPlaying] = useState(false)
  const [speedId, setSpeedId] = useState(DEFAULT_REPLAY_SPEED)
  const timeRef = useRef(0)
  // Simulated seconds per real second; Fit plays the whole run in a minute.
  const speed = REPLAY_SPEEDS.find((s) => s.id === speedId)?.simSecPerSec ?? Math.max(total, 1)
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
  // Each job waits at the Start that releases its product (the first Start
  // for a product no Start lists).
  const sources = useMemo(() => targets.filter((t) => t.isSource), [targets])
  const sourceOf = useMemo(() => (job: Job) => sources.find((t) => t.products?.includes(job.prefix)) ?? sources[0], [sources])
  const drain = useMemo(() => targets.find((t) => t.isDrain), [targets])

  // Where a job is at `time` (undefined: not on the Canvas): its box, right
  // of it (`after`: waiting to move on) or on it, when it got there and when
  // it moves on (End: when it got there; `latest` — End shows the last one).
  const place = useMemo(() => {
    const find = (v: Visit) => byKey.get(`${v.station}|${v.machine}`) ?? byKey.get(`${v.station}|1`)
    return (j: Job, time: number): Place | undefined => {
      const { release, finish, visits } = j
      if (j.gone !== null && time >= j.gone) return undefined // used up in an assembly
      const firstStart = visits[0]?.start ?? Infinity
      // A line with no End: the job finished in its last Buffer and stays
      // there (the visit runs past its finish, to the end of the run).
      const last = visits[visits.length - 1]
      const held = !!last && finish !== null && last.end > finish
      const atStart = (): Place | undefined => {
        const target = sourceOf(j)
        return target && { target, after: true, came: release ?? 0, leaves: firstStart, rank: firstStart, latest: false, status: 'Released — waiting for its first station' }
      }
      // The very first frame shows the starting point: every job released at
      // the start is still at Start, before the first moves of that same
      // minute (e.g. Job 1 into a free Station 1) happen.
      if (time <= 0 && sources.length > 0) return release !== null && release <= 0 ? atStart() : undefined
      if (finish !== null && time >= finish && !held && !drain && last) {
        // A line with no End: finished jobs collect just right of the last
        // box they left, like End (the job finished last, with the count).
        const target = find(last)
        return target && { target, after: true, came: finish, leaves: finish, rank: finish, latest: true, status: 'Finished' }
      }
      if (finish !== null && time >= finish && !held) {
        return drain && { target: drain, after: false, came: finish, leaves: finish, rank: finish, latest: true, status: 'Finished' }
      }
      if (!visits.length || time < firstStart) {
        // Released, waiting for its first station.
        return release !== null && time >= release ? atStart() : undefined
      }
      let i = visits.length - 1
      while (i > 0 && visits[i].start > time) i--
      const v = visits[i]
      const target = find(v)
      if (!target) return undefined
      const nextMove = visits[i + 1]?.start ?? finish ?? Infinity
      // Collected in the last Buffer: like End, its circle shows the job
      // that came in last, with the count of all jobs in it.
      if (held && i === visits.length - 1) {
        return { target, after: false, came: v.start, leaves: v.end, rank: v.start, latest: true, status: 'Collected — stays in the last buffer' }
      }
      if (time < v.end) {
        // Being worked on / riding. Parts on an Assembly never cover the
        // main part (the circle shown).
        const status = v.part ? 'Part — waiting to be assembled'
          : v.piece ? 'Piece — waiting for its next station'
            : time < v.work ? 'Waiting for parts' : 'Being worked on'
        return { target, after: false, came: v.start, leaves: v.end, rank: v.part ? Infinity : v.end, latest: false, status }
      }
      if (i === visits.length - 1 && target.isDrain) {
        return { target, after: false, came: v.end, leaves: v.end, rank: v.end, latest: true, status: 'Finished' }
      }
      return { target, after: true, came: v.end, leaves: nextMove, rank: nextMove, latest: false, status: 'Waiting to move on' }
    }
  }, [byKey, sources, sourceOf, drain])

  // Where every job is right now, grouped into one circle per spot. Each
  // spot shows the job that leaves it next (the log already knows when each
  // job moves on, so this follows FIFO/LIFO/Cyclic by itself); End shows the
  // job that finished last.
  const groups = useMemo(() => {
    interface Group { id: string; nodeId: string; after: boolean; count: number; job: Job; key: number }
    const spots = new Map<string, Group>()
    for (const j of jobs) {
      const p = place(j, time)
      if (!p) continue
      const id = spotId(p)
      const g = spots.get(id)
      if (!g) { spots.set(id, { id, nodeId: p.target.nodeId, after: p.after, count: 1, job: j, key: p.rank }); continue }
      g.count++
      if (p.latest ? p.rank > g.key : p.rank < g.key) { g.job = j; g.key = p.rank }
    }
    return [...spots.values()]
  }, [jobs, time, place])

  // Hover card: the spot under the mouse; it stays open while the mouse
  // moves from the circle onto the card (to scroll a long list).
  const [hovered, setHovered] = useState<string | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const hoverOn = (id: string) => { window.clearTimeout(closeTimer.current); setHovered(id) }
  const hoverOff = () => { closeTimer.current = window.setTimeout(() => setHovered(null), 150) }
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  const hoveredGroup = hovered ? groups.find((g) => g.id === hovered) : undefined
  // Every job in the hovered spot, the one leaving next first.
  const hoveredJobs = useMemo(() => {
    if (!hovered) return []
    const here: { job: Job; place: Place }[] = []
    for (const j of jobs) {
      const p = place(j, time)
      if (p && spotId(p) === hovered) here.push({ job: j, place: p })
    }
    return here.sort((a, b) => (a.place.latest ? b.place.rank - a.place.rank : a.place.rank - b.place.rank))
  }, [hovered, jobs, time, place])
  // Job-id prefix -> product name.
  const productOf = useMemo(() => {
    const names = new Map(Object.keys(variantColors ?? {}).map((v) => [jobPrefix(v), v]))
    return (j: Job) => names.get(j.prefix) ?? j.prefix
  }, [variantColors])

  // No job moved in this run (e.g. too short for any to finish): nothing to play, but
  // the bar stays, greyed out, with this run's figures and Sim setting.
  if (total <= 0) {
    return (
      <Panel position="bottom-center">
        <div className="w-[min(900px,calc(100vw-80px))]">
          <IdleReplayBar
            runStartMs={t0 > 0 ? wallMs(t0) : undefined}
            runMin={runMinutes}
            settings={<div className="flex items-center gap-1.5"><SimSettingsMenu compact up onConfig={() => openSimDialog('config')} onTimer={() => openSimDialog('timer')} />{runControls}</div>}
          />
        </div>
      </Panel>
    )
  }

  const clock = (t: number) => (Number.isFinite(t) ? fmtReplayClock(wallMs(t0), t) : '—')
  const boxName = (t: ReplayTarget) => (t.machine > 1 ? `${t.station} #${t.machine}` : t.station)
  const card = (() => {
    const n = hoveredGroup && nodeInternals.get(hoveredGroup.nodeId)
    if (!hoveredGroup || !n?.positionAbsolute || !n.width || !n.height || !hoveredJobs.length) return null
    const x = hoveredGroup.after ? n.positionAbsolute.x + n.width + 14 : n.positionAbsolute.x + n.width / 2
    const y = n.positionAbsolute.y + n.height / 2
    return { left: (x + CIRCLE / 2) * zoom + tx + 10, top: y * zoom + ty - 20 }
  })()

  return (
    <>
      <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 5 }}>
        <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})`, transformOrigin: '0 0' }}>
          {groups.map((g) => {
            const n = nodeInternals.get(g.nodeId)
            if (!n?.positionAbsolute || !n.width || !n.height) return null
            const x = g.after ? n.positionAbsolute.x + n.width + 14 : n.positionAbsolute.x + n.width / 2
            const y = n.positionAbsolute.y + n.height / 2
            // Attached parts: equal slices, one colour per part type.
            const mix = g.job.mix && time >= g.job.mix.from ? g.job.mix.colors : null
            const background = mix && mix.length > 1
              ? `conic-gradient(${mix.map((c, i) => `${c} ${(i * 100) / mix.length}% ${((i + 1) * 100) / mix.length}%`).join(', ')})`
              : mix?.[0] ?? g.job.color
            return (
              <div
                key={g.id}
                onMouseEnter={() => hoverOn(g.id)}
                onMouseLeave={hoverOff}
                className="absolute rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold tabular-nums leading-none"
                style={{ left: x - CIRCLE / 2, top: y - CIRCLE / 2, width: CIRCLE, height: CIRCLE, background, pointerEvents: 'auto', fontSize: g.job.num >= 1000 ? 9 : g.job.num >= 100 ? 10.5 : 12 }}
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

        {/* Hover card: the job (or every job) in the spot; updates as it plays. */}
        {card && (() => {
          const where = hoveredJobs[0].place
          const one = hoveredJobs.length === 1
          const shown = hoveredJobs.slice(0, MAX_LISTED)
          return (
            <div
              onMouseEnter={() => hoverOn(hovered!)}
              onMouseLeave={hoverOff}
              className="absolute w-64 rounded-xl border border-gray-200 bg-white/95 backdrop-blur-sm shadow-lg text-[11px] text-gray-700"
              style={{ left: card.left, top: card.top, pointerEvents: 'auto' }}
            >
              <div className="px-3 py-2 border-b border-gray-100 font-semibold text-gray-900">
                {where.after ? `After ${boxName(where.target)}` : boxName(where.target)}
                {!one && <span className="font-normal text-gray-500"> · {hoveredJobs.length} jobs</span>}
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
                {shown.map(({ job: j, place: p }) => (
                  <div key={j.id} className="px-3 py-1.5 space-y-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-gray-900">{j.id}</span>
                      <span className="text-gray-500 truncate">{productOf(j)}</span>
                    </div>
                    <div>{p.status}</div>
                    <div className="text-gray-500 tabular-nums">
                      {p.status === 'Finished' ? `Finished ${clock(p.came)}` : `Came ${clock(p.came)} · Leaves ${clock(p.leaves)}`}
                    </div>
                    {j.madeFrom && (!j.mix || time >= j.mix.from) && <div className="text-gray-500">Made from {j.madeFrom.join(' + ')}</div>}
                  </div>
                ))}
                {hoveredJobs.length > shown.length && (
                  <div className="px-3 py-1.5 text-gray-400">and {hoveredJobs.length - shown.length} more</div>
                )}
              </div>
            </div>
          )
        })()}
      </div>

      <Panel position="bottom-center">
        <div className="w-[min(900px,calc(100vw-80px))]">
          <ReplayBar
            playing={playing}
            onToggle={() => {
              if (timeRef.current >= total) { timeRef.current = 0; setTime(0) }
              setPlaying((p) => !p)
            }}
            onRestart={() => { setPlaying(false); timeRef.current = 0; setTime(0) }}
            speedId={speedId}
            onSpeed={setSpeedId}
            pct={total > 0 ? (time / total) * 100 : 0}
            onScrub={(pct) => { setPlaying(false); timeRef.current = (pct / 100) * total; setTime(timeRef.current) }}
            clock={fmtReplayClock(wallMs(t0), time)}
            elapsedMin={time}
            startMs={wallMs(t0)}
            runMin={runMinutes ?? total}
            settings={<div className="flex items-center gap-1.5"><SimSettingsMenu compact up onConfig={() => openSimDialog('config')} onTimer={() => openSimDialog('timer')} />{runControls}</div>}
          />
        </div>
      </Panel>
    </>
  )
}
