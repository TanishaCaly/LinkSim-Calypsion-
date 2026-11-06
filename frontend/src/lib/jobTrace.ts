export interface JobTraceRow {
  jobId: string
  station: string
  arrival: string | null
  departure: string | null
  windowMin: number | null
  waitingMin: number | null
  processingMin: number | null
  otherTimeMin: number | null
  // the parts of otherTimeMin (minutes)
  breakdownMin: number
  operatorMin: number
  materialMin: number
  setupMin: number
  reworkMin: number
  pauseMin: number
  totalMin: number | null
  status: string
  delayReason: string
}

export function parseJobTrace(completionLog: Record<string, unknown[]>): JobTraceRow[] {
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
      rows.push({ jobId, station, arrival, departure, windowMin, waitingMin, processingMin, otherTimeMin, breakdownMin, operatorMin, materialMin, setupMin, reworkMin, pauseMin, totalMin, status, delayReason })
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
