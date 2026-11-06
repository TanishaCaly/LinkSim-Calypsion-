import { scenariosApi } from '@/api/scenarios'
import { simulationsApi } from '@/api/simulations'
import type { ProcessStep, RunDetail, Scenario } from '@/types'

// What a scenario card shows beyond the list endpoint's name/description/dates:
// counts from the full scenario and the newest run's status and headline KPIs.
// Two requests per card; react-query caches them (see ScenarioManager).
export type CardStatus = 'completed' | 'running' | 'failed' | 'stopped' | 'none'

export interface ScenarioSummary {
  stations: number
  /** Start (Source) boxes */
  lines: number
  variants: number
  operators: number
  /** "1 week", "8 h", … from SIM_TIME */
  simLabel: string | null
  /** The first variant's route as columns of station names (a split = several in one column). */
  columns: string[][]
  status: CardStatus
  throughput: number | null
  avgUtil: number | null
  bottleneck: string | null
  error: string | null
}

const NOT_STATIONS = new Set(['Worker', 'Worker Controller', 'Workplace', 'Source', 'Drain'])

function stepNames(step: ProcessStep): string[] {
  const r = step.resource
  if (typeof r === 'string') return [r]
  return r?.options?.length ? r.options : [step.operation]
}

// Consecutive steps with the same branch number are one split (one column).
function routeColumns(steps: ProcessStep[]): string[][] {
  const cols: string[][] = []
  let lastBranch: number | undefined
  for (const st of steps) {
    const names = stepNames(st)
    if (st.branch !== undefined && st.branch === lastBranch && cols.length) cols[cols.length - 1].push(...names)
    else cols.push([...names])
    lastBranch = st.branch
  }
  return cols
}

export function simLength(minutes: number | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  if (minutes % 10080 === 0) return `${minutes / 10080} week${minutes === 10080 ? '' : 's'}`
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${minutes} min`
}

function statusOf(run: RunDetail | undefined): CardStatus {
  if (!run) return 'none'
  if (run.status === 'completed') return 'completed'
  if (run.status === 'failed') return 'failed'
  // the engine also reports 'stopped' (a run the user stopped; partial results are kept)
  if ((run.status as string) === 'stopped') return 'stopped'
  return 'running' // pending / running
}

export function summarise(sc: Scenario, runs: RunDetail[]): ScenarioSummary {
  const latest = [...runs].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0]
  const firstVariant = Object.values(sc.processflow_data ?? {})[0] ?? []
  return {
    stations: Object.entries(sc.stations_data ?? {}).filter(([, c]) => !NOT_STATIONS.has(String(c['Station Type'] ?? ''))).length,
    lines: Object.values(sc.stations_data ?? {}).filter((c) => c['Station Type'] === 'Source').length,
    variants: Object.keys(sc.processflow_data ?? {}).length,
    operators: Object.keys(sc.operators_data ?? {}).length,
    simLabel: simLength(sc.simulation_config?.SIM_TIME),
    columns: routeColumns(firstVariant),
    status: statusOf(latest),
    throughput: latest?.kpi_throughput ?? null,
    avgUtil: latest?.kpi_avg_utilization ?? null,
    bottleneck: latest?.kpi_bottleneck_station ?? null,
    error: latest?.status === 'failed' ? latest.error_message : null,
  }
}

export async function fetchScenarioSummary(id: number): Promise<ScenarioSummary> {
  const [sc, runs] = await Promise.all([scenariosApi.get(id), simulationsApi.listRuns(id).catch(() => [] as RunDetail[])])
  return summarise(sc, runs)
}
