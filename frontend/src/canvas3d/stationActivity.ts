// Which stations are busy at a given point on the playback timeline, from the
// run's completion log — drives each model's Running/Waiting animation.

export type AnimState = 'Running' | 'Waiting'

export interface StationActivity {
  // Absolute ms that timeline position 0 maps to.
  globalStart: number
  // Per station: sorted job start and end times (ms). A job cut off by the
  // sim horizon has no end, so it counts as in process until the end.
  byStation: Map<string, { starts: number[]; ends: number[] }>
}

function parseMs(v: unknown): number {
  return typeof v === 'string' ? new Date(v.replace(' ', 'T')).getTime() : NaN
}

export function buildStationActivity(log: Record<string, unknown[]>): StationActivity {
  let globalStart = Infinity
  const byStation = new Map<string, { starts: number[]; ends: number[] }>()
  for (const [station, rows] of Object.entries(log)) {
    const starts: number[] = []
    const ends: number[] = []
    for (const r of rows as Record<string, unknown>[]) {
      // A part waiting in an Assembly's room is not work on the machine.
      if (r['status'] === 'Assembled') continue
      const s = parseMs(r['process_start_time_real'])
      if (isNaN(s)) continue
      const e = parseMs(r['process_end_time_real'])
      starts.push(s)
      ends.push(isNaN(e) ? Infinity : e)
      // Same zero as the job timeline (jobTimeline.ts): the earliest start among rows
      // that have both a start and an end.
      if (!isNaN(e) && s < globalStart) globalStart = s
    }
    starts.sort((a, b) => a - b)
    ends.sort((a, b) => a - b)
    byStation.set(station, { starts, ends })
  }
  return { globalStart: globalStart === Infinity ? 0 : globalStart, byStation }
}

// How many values in an ascending array are <= t.
function countUpTo(sorted: number[], t: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Jobs in process at `station` at timeline position `simMs` (start <= t < end).
export function activeCount(activity: StationActivity, station: string, simMs: number): number {
  const entry = activity.byStation.get(station)
  if (!entry) return 0
  const t = activity.globalStart + simMs
  return countUpTo(entry.starts, t) - countUpTo(entry.ends, t)
}
