// Where every job is, and what it is doing, at any point on the playback
// timeline — rebuilt from the run's completion log and nothing else.
//
// Everything here follows what the engine recorded:
//  - a job reaches a station when it arrives (the visit's end minus its Cycle
//    Time) and waits in that station's queue until the machine is free; the
//    engine has no travel time, so a job is at the next station the moment it
//    leaves the last one
//  - queue wait is the row's "Blocked Time"; any setup follows it
//  - the machine is held from process start to process end (pauses, material
//    waits and breakdowns all happen inside that window)
//  - a job still queued at the end of the run has a "Waiting" row with no times
//    and one cut off by the horizon has a start but no end
//  - an Assembly: a part has an "Assembled" row (start = it went into the
//    Assembly's room, end = it was used) and, until there is room for it, waits
//    on the station it came from; the main part sits on the machine for its
//    "Waiting for parts" minutes. The parts (and a main part that leaves as a
//    New FE) are gone once assembled — they are not finished jobs.
// Times are milliseconds from the timeline's zero, the same zero the 3D view's
// other timeline code uses (the earliest start among rows that have an end).

const MIN = 60_000

export interface Visit {
  station: string
  // All in ms from the timeline zero. end is Infinity while the job is still
  // there at the end of the run; start is Infinity while it is still queued.
  arrival: number
  release: number // machine acquired: arrival + queue wait
  start: number // processing starts (after any setup)
  end: number
  // Exact per-visit totals from the log, in minutes.
  queueMin: number
  processingMin: number
  pauseMin: number
  downtimeMin: number
  materialMin: number
  reworkMin: number
  setupMin: number
  operatorMin: number
  // Assembly main part: minutes it sat on the machine waiting for its parts.
  partsMin: number
  // Assembly main part that never got its parts before the run ended.
  waitingParts: boolean
  status: string
  // Lowest free machine at this station when the visit starts (-1 while queued).
  machine: number
}

// One entry of simulation_state.assemblies, keyed by what the assembly made.
export interface AssemblyInfo {
  station: string
  main: string
  mode: string
  parts: string[]
}

// One entry of simulation_state.dismantles, keyed by the job that was dismantled.
export interface DismantleInfo {
  station: string
  mode: string
  pieces: string[]
}

export interface Job {
  id: string
  visits: Visit[]
  // A part used up in an Assembly, or a main part that left it as a New FE:
  // gone at `at` into the assembly's station, not a finished job. A job whose
  // pieces all got new names (Dismantle) is gone the same way (kind 'dismantle').
  absorbed?: { at: number; station: string; into: string; kind?: 'dismantle' }
  // An extra piece a Dismantle made: it sits on the Dismantle from `at` until
  // its first station takes it.
  piece?: { of: string; station: string; at: number; machine: number }
  // Index into Timeline.groups: the pieces of one dismantled job count as one
  // finished job, once the last of them is done.
  group?: number
  // The job left the line for good without finishing: turned away by a full
  // Worker Controller queue (rejected) or lost when its machine failed
  // mid-operation (scrapped). Not a finished job.
  outcome?: { kind: 'rejected' | 'scrapped'; at: number; station: string }
}

export interface Timeline {
  zeroAbs: number // absolute ms of the timeline zero
  span: number // ms from zero to the last recorded event
  jobs: Job[]
  stations: string[]
  // One per dismantled job: when it was dismantled, and when its last piece finished.
  groups: { at: number; finishAt: number }[]
  // How many jobs ended rejected / scrapped in the run.
  rejected: number
  scrapped: number
}

// parts: an Assembly's main part on the machine waiting for its parts.
// blocked: a part held on its own station until the Assembly has room for it.
export type Phase = 'waiting' | 'setup' | 'processing' | 'parts' | 'blocked'

export interface JobState {
  job: number
  station: string
  visit: number
  phase: Phase
  machine: number
  arrival: number
  rank: number // place in the station's queue (0 = next), while waiting
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0)
const parseMs = (v: unknown): number => (typeof v === 'string' ? new Date(v.replace(' ', 'T')).getTime() : NaN)

export function buildTimeline(
  log: Record<string, unknown[]>,
  assemblies: Record<string, AssemblyInfo> = {},
  dismantles: Record<string, DismantleInfo> = {},
): Timeline {
  let zeroAbs = Infinity
  let lastAbs = -Infinity
  for (const rows of Object.values(log)) {
    for (const r of rows as Record<string, unknown>[]) {
      const s = parseMs(r['process_start_time_real'])
      const e = parseMs(r['process_end_time_real'])
      if (!isNaN(s) && !isNaN(e)) {
        if (s < zeroAbs) zeroAbs = s
        if (e > lastAbs) lastAbs = e
      }
    }
  }
  if (zeroAbs === Infinity) return { zeroAbs: 0, span: 0, jobs: [], stations: Object.keys(log), groups: [], rejected: 0, scrapped: 0 }
  const span = lastAbs - zeroAbs

  const byJob = new Map<string, Visit[]>()
  for (const [station, rows] of Object.entries(log)) {
    for (const r of rows as Record<string, unknown>[]) {
      const status = String(r['status'] ?? '')
      if (status !== 'Completed' && status !== 'In Progress' && status !== 'Waiting' && status !== 'Assembled' && status !== 'Rejected' && status !== 'Scrapped') continue
      const sAbs = parseMs(r['process_start_time_real'])
      const eAbs = parseMs(r['process_end_time_real'])
      const queueMin = num(r['Blocked Time'])
      const visit: Visit = {
        station,
        arrival: NaN, release: NaN,
        start: isNaN(sAbs) ? Infinity : sAbs - zeroAbs,
        end: isNaN(eAbs) ? Infinity : eAbs - zeroAbs,
        queueMin,
        processingMin: num(r['Processing Time']),
        pauseMin: num(r['pause_time']),
        downtimeMin: num(r['station_downtime']),
        materialMin: num(r['material_unavailability']),
        reworkMin: num(r['total_rework_time']),
        setupMin: num(r['total_setup_time']),
        operatorMin: num(r['operators_downtime']),
        partsMin: num(r['Waiting for parts']),
        waitingParts: status === 'Waiting' && r['delay_reason'] === 'Waiting for parts',
        status,
        machine: -1,
      }
      // Completed visits know when they arrived: the end minus the Cycle Time.
      if (status === 'Completed') {
        visit.arrival = visit.end - num(r['Cycle Time']) * MIN
        visit.release = visit.arrival + queueMin * MIN
      }
      // A part used in an Assembly: in the Assembly's room from its start until
      // it was used, which is the whole visit (it never takes the machine).
      if (status === 'Assembled') {
        visit.arrival = visit.start
        visit.release = visit.start
        visit.start = visit.end
      }
      const id = String(r['job_id'] ?? '')
      let list = byJob.get(id)
      if (!list) byJob.set(id, (list = []))
      list.push(visit)
    }
  }

  // Which job each part went into, and which main part left as a new job.
  const partInto = new Map<string, string>()
  const mainInto = new Map<string, { out: string; station: string }>()
  for (const [out, rec] of Object.entries(assemblies)) {
    for (const p of rec.parts) partInto.set(p, out)
    if (out !== rec.main) mainInto.set(rec.main, { out, station: rec.station })
  }

  // A Dismantle makes its extra pieces the moment the job's work there ends.
  const dismantledVisit = (whole: string, station: string): Visit | undefined => {
    let found: Visit | undefined
    for (const v of byJob.get(whole) ?? []) {
      if (v.station === station && v.status === 'Completed' && (!found || v.start > found.start)) found = v
    }
    return found
  }
  const pieceAt = new Map<string, number>()
  for (const [whole, rec] of Object.entries(dismantles)) {
    const done = dismantledVisit(whole, rec.station)
    if (done) for (const pid of rec.pieces) if (pid !== whole) pieceAt.set(pid, done.end)
  }

  const jobs: Job[] = []
  for (const [id, visits] of byJob) {
    visits.sort((a, b) => a.start - b.start) // queued visit (start Infinity) sorts last
    // No travel time in the engine: a job arrives where it is going the moment
    // it leaves the last station, and every job is released at the zero (a
    // Dismantle's piece, when the Dismantle made it).
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i]
      if (isNaN(v.arrival)) {
        v.arrival = i === 0 ? pieceAt.get(id) ?? 0 : visits[i - 1].end
        v.release = v.start // an in-progress visit has no recorded queue split
      }
    }
    const job: Job = { id, visits }
    const last = visits[visits.length - 1]
    if ((last.status === 'Rejected' || last.status === 'Scrapped') && last.end !== Infinity) {
      job.outcome = { kind: last.status === 'Rejected' ? 'rejected' : 'scrapped', at: last.end, station: last.station }
    }
    const part = partInto.get(id)
    const main = mainInto.get(id)
    if (part && last.status === 'Assembled') job.absorbed = { at: last.end, station: last.station, into: part }
    else if (main && last.station === main.station && last.end !== Infinity) job.absorbed = { at: last.end, station: last.station, into: main.out }
    jobs.push(job)
  }
  jobs.sort((a, b) => (a.id < b.id ? -1 : 1))

  assignMachines(jobs)

  // Dismantles: the extra pieces wait on the Dismantle until their first station
  // takes them, and a dismantled job counts as one finished job once its last
  // piece is done (as in the engine's completed_jobs).
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const groups: Timeline['groups'] = []
  for (const [whole, rec] of Object.entries(dismantles)) {
    const w = byId.get(whole)
    const done = dismantledVisit(whole, rec.station)
    if (!w || !done) continue
    const members: Job[] = []
    for (const pid of rec.pieces) {
      const p = byId.get(pid)
      if (!p) continue
      if (pid !== whole) p.piece = { of: whole, station: rec.station, at: done.end, machine: Math.max(done.machine, 0) }
      members.push(p)
    }
    // Every piece got a new name: the job itself ends here.
    if (!rec.pieces.includes(whole)) w.absorbed = { at: done.end, station: rec.station, into: rec.pieces[0] ?? whole, kind: 'dismantle' }
    if (members.length === 0) continue
    members.forEach((m) => { m.group = groups.length })
    groups.push({ at: done.end, finishAt: Math.max(...members.map((m) => m.visits[m.visits.length - 1].end)) })
  }
  return {
    zeroAbs, span, jobs, stations: Object.keys(log), groups,
    rejected: jobs.filter((j) => j.outcome?.kind === 'rejected').length,
    scrapped: jobs.filter((j) => j.outcome?.kind === 'scrapped').length,
  }
}

// The log has no machine number. Capacity is never exceeded in the engine, so
// giving each starting job the lowest free machine always fits; the count of
// busy machines is exact, which machine is a choice.
function assignMachines(jobs: Job[]) {
  const byStation = new Map<string, Visit[]>()
  for (const job of jobs) {
    for (const v of job.visits) {
      // A part in an Assembly's room never takes a machine.
      if (v.start === Infinity || v.status === 'Assembled') continue
      let list = byStation.get(v.station)
      if (!list) byStation.set(v.station, (list = []))
      list.push(v)
    }
  }
  for (const visits of byStation.values()) {
    visits.sort((a, b) => a.start - b.start)
    const busyUntil: number[] = [] // per machine
    for (const v of visits) {
      let m = busyUntil.findIndex((t) => t <= v.start)
      if (m < 0) m = busyUntil.length
      busyUntil[m] = v.end
      v.machine = m
    }
  }
}

// Index of the last element with key <= t, or -1.
function lastAtOrBefore(visits: Visit[], t: number): number {
  let lo = 0
  let hi = visits.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (visits[mid].arrival <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

// Every job still in the line at tMs, with its station, phase and queue rank.
// Jobs that have left after their last station are not included.
export function snapshot(tl: Timeline, tMs: number, out: JobState[] = []): JobState[] {
  out.length = 0
  for (let j = 0; j < tl.jobs.length; j++) {
    const job = tl.jobs[j]
    const visits = job.visits
    const i = lastAtOrBefore(visits, tMs)
    if (i < 0) {
      // A piece a Dismantle made waits on the Dismantle until its first station takes it.
      const p = job.piece
      if (p && tMs >= p.at && tMs < visits[0].arrival) {
        out.push({ job: j, station: p.station, visit: 0, phase: 'blocked', machine: p.machine, arrival: p.at, rank: 0 })
      }
      continue
    }
    const v = visits[i]
    if (tMs >= v.end) {
      // Finished here but its next station has not taken it yet (an Assembly
      // with no room, a Dismantle holding its pieces, a full buffer): the job
      // stays on this machine until then.
      const next = visits[i + 1]
      if (next && tMs < next.arrival) {
        out.push({ job: j, station: v.station, visit: i, phase: 'blocked', machine: Math.max(v.machine, 0), arrival: v.end, rank: 0 })
      }
      continue // finished its last station
    }
    let phase: Phase
    if (v.waitingParts) phase = 'parts' // a main part that never got its parts
    else if (tMs >= v.start) phase = 'processing'
    else if (v.partsMin > 0 && tMs >= v.release) phase = 'parts'
    else if (tMs >= v.release && v.setupMin > 0) phase = 'setup'
    else phase = 'waiting'
    out.push({ job: j, station: v.station, visit: i, phase, machine: phase === 'waiting' ? -1 : Math.max(v.machine, 0), arrival: v.arrival, rank: 0 })
  }
  // Queue rank: waiting jobs at a station, earliest arrival first.
  const queues = new Map<string, JobState[]>()
  for (const s of out) {
    if (s.phase !== 'waiting') continue
    let q = queues.get(s.station)
    if (!q) queues.set(s.station, (q = []))
    q.push(s)
  }
  for (const q of queues.values()) {
    q.sort((a, b) => a.arrival - b.arrival || a.job - b.job)
    q.forEach((s, rank) => { s.rank = rank })
  }
  return out
}

export interface StationCount {
  waiting: number
  processing: number
}

export function countByStation(states: JobState[]): Map<string, StationCount> {
  const counts = new Map<string, StationCount>()
  for (const s of states) {
    let c = counts.get(s.station)
    if (!c) counts.set(s.station, (c = { waiting: 0, processing: 0 }))
    if (s.phase === 'waiting' || s.phase === 'blocked' || s.phase === 'parts') c.waiting++
    else c.processing++
  }
  return counts
}
