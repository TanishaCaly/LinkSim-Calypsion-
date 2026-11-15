// Where each pool Worker is on the playback timeline. The engine reports only
// each worker's totals per station (worker_pool_stats), not who did which job
// when, so the split is an estimate: the stations and times come from the job
// log (when a station is processing), and each job goes to a free worker that
// served that station, balanced by the engine's job counts per worker.
import type { StationActivity } from './stationActivity'
import type { WorkerPoolStat } from '@/types'

export interface WorkerSeg { station: string; s: number; e: number } // absolute ms

const MIN = 60_000

export function planWorkers(activity: StationActivity, pools: Record<string, WorkerPoolStat> | undefined): Map<string, WorkerSeg[]> {
  const workers = Object.values(pools ?? {}).flatMap((p) => p.workers ?? [])
  const quota = new Map<string, Map<string, number>>() // worker -> station -> jobs left
  for (const w of workers) quota.set(w.name, new Map(w.workplaces.filter((x) => x.jobs > 0).map((x) => [x.station, x.jobs])))
  const total = new Map<string, Map<string, number>>()
  for (const [n, q] of quota) total.set(n, new Map(q))

  const jobs: WorkerSeg[] = []
  for (const [station, { starts, ends }] of activity.byStation) {
    if (!workers.some((w) => quota.get(w.name)!.has(station))) continue
    starts.forEach((s, i) => jobs.push({ station, s, e: ends[i] ?? Infinity }))
  }
  jobs.sort((a, b) => a.s - b.s)

  const segs = new Map<string, WorkerSeg[]>(workers.map((w) => [w.name, []]))
  const freeAt = new Map<string, number>(workers.map((w) => [w.name, -Infinity]))
  for (const j of jobs) {
    let best: string | null = null
    let bestRatio = Infinity
    for (const w of workers) {
      const left = quota.get(w.name)!.get(j.station)
      if (!left || freeAt.get(w.name)! > j.s) continue
      const ratio = 1 - left / total.get(w.name)!.get(j.station)! // share of its quota already used
      if (ratio < bestRatio) { bestRatio = ratio; best = w.name }
    }
    if (!best) continue
    quota.get(best)!.set(j.station, quota.get(best)!.get(j.station)! - 1)
    freeAt.set(best, j.e)
    segs.get(best)!.push(j)
  }
  return segs
}

export interface WorkerPose { station: string | null; from: string | null; to: string | null; k: number; working: boolean }

// Walking takes this long on the timeline: a few minutes, stretched for long runs so it is visible.
export function travelMs(spanMs: number): number {
  return Math.max(5 * MIN, spanMs / 60)
}

// Pose at absolute time t: working at a station, walking to the next one, or idle at the last one
// (a null station is the worker's own spot). When the next job starts right after this one, the
// walk begins during the second half of this job so it is still visible.
export function poseAt(segs: WorkerSeg[], t: number, travel: number): WorkerPose {
  let lo = 0, hi = segs.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].s <= t) lo = m + 1; else hi = m }
  const cur = lo > 0 ? segs[lo - 1] : null
  const next = segs[lo]
  if (next && next.station !== (cur ? cur.station : null)) {
    const half = cur && isFinite(cur.e) ? (cur.e - cur.s) / 2 : 0
    const tr = Math.min(travel, cur ? next.s - cur.e + half : travel)
    const depart = next.s - tr
    if (t >= depart && tr > 0) return { station: null, from: cur ? cur.station : null, to: next.station, k: (t - depart) / tr, working: false }
  }
  if (cur && t < cur.e) return { station: cur.station, from: null, to: null, k: 0, working: true }
  return { station: cur ? cur.station : null, from: null, to: null, k: 0, working: false }
}
