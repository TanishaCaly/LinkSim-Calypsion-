// ─── Scenario ────────────────────────────────────────────────────────────────

export interface StationConfig {
  capacity: number
  // Legacy count (1/2/3, meaning "shifts 1..N") from the Stations tab, OR an
  // explicit list of active shift numbers (e.g. [2, 3]) from the Canvas
  // Build panel's per-station shift picker — the engine accepts both.
  shifts_per_day: number | number[]
  operator_per_station: number
  'Station Type'?: string
  // Conveyor only — minutes to traverse the belt. The engine uses this instead
  // of the process-flow step's duration for Conveyor stations.
  'Transport Time'?: number
  'Assembly Count'?: number
  'Assembly Inputs'?: Record<string, number>
  'Failure rate': number
  'Repair Time': number
  'Setup time': number
  'Buffer Capacity': number
  'Buffer Discipline': string
  'Buffer Width': number
  'Buffer Depth': number
  'Buffer Height': number
  'Buffer Count'?: number
  'PM Schedule': string
  'Material Shortage Probability (%)': number
  'Rework Probability (%)': number
  shift1: string
  shift2: string
  shift3: string
  // Per-station override of which weekdays a given shift number runs on for
  // THIS station only (Python weekday numbering: Monday=0 ... Sunday=6).
  // Absent/undefined falls back to the scenario's global Shift Calendar
  // (WORKING_DAYS_n in simulation_config) for that shift number — set only
  // when a station's own calendar genuinely differs from every other
  // station using the same shift number. A 4th+ shift's override lives at
  // the same `workingDays{n}` key, covered by the index signature below.
  workingDays1?: number[]
  workingDays2?: number[]
  workingDays3?: number[]
  // Per-station override of a shift's break windows (e.g. lunch), same
  // override-or-fall-back-to-global pattern as workingDaysN above. A 4th+
  // shift's override lives at the same `breaks{n}` key, covered by the
  // index signature below.
  breaks1?: { start: number; duration: number }[]
  breaks2?: { start: number; duration: number }[]
  breaks3?: { start: number; duration: number }[]
  STATION_DOWNTIME: number
  [key: string]: unknown
}

export interface RoutingConfig {
  mode: 'round_robin' | 'percentage' | 'condition' | 'shortest_queue'
  options: string[]
  weights?: number[]
  rules?: { if: string; resource: string }[]
  default?: string
}

export interface ProcessStep {
  operation: string
  resource: string | RoutingConfig
  duration: number
}

export interface OperatorConfig {
  'Skill Rating': number
  'Availability (%)': number
}

export interface SimConfig {
  SIM_TIME: number
  WARMUP_TIME?: number
  SHIFT_DURATION: number
  SHIFT_1_START: number
  SHIFT_1_END: number
  SHIFT_2_START: number
  SHIFT_2_END: number
  SHIFT_3_START: number
  SHIFT_3_END: number
  WORKING_DAYS_1?: number[]
  WORKING_DAYS_2?: number[]
  WORKING_DAYS_3?: number[]
  BREAKS_1?: { start: number; duration: number }[]
  BREAKS_2?: { start: number; duration: number }[]
  BREAKS_3?: { start: number; duration: number }[]
  // Cosmetic display names (e.g. "Morning" instead of "Shift 1") — inert to
  // the engine, just shown wherever a shift's name appears in the UI.
  SHIFT_1_NAME?: string
  SHIFT_2_NAME?: string
  SHIFT_3_NAME?: string
  STATION_DOWNTIME: number
  ACTIVE_PROCESSING_TIME: number
}

export interface Scenario {
  id: number
  name: string
  description: string | null
  created_at: string
  updated_at: string
  stations_data: Record<string, StationConfig>
  processflow_data: Record<string, ProcessStep[]>
  variant_quantities: Record<string, number>
  variant_intervals: Record<string, number>
  setup_matrix: Record<string, Record<string, number>>
  operators_data: Record<string, OperatorConfig>
  simulation_config: SimConfig
}

export interface ScenarioListItem {
  id: number
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

export interface ScenarioCreate {
  name: string
  description?: string
  stations_data: Record<string, StationConfig>
  processflow_data: Record<string, ProcessStep[]>
  variant_quantities: Record<string, number>
  variant_intervals?: Record<string, number>
  setup_matrix?: Record<string, Record<string, number>>
  operators_data: Record<string, OperatorConfig>
  simulation_config?: Partial<SimConfig> | Record<string, unknown>
}

// ─── Simulation Runs ─────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface RunResponse {
  id: number
  scenario_id: number
  status: RunStatus
  created_at: string
}

export interface StationStat {
  station_name: string
  station_utilization: number
  operator_utilization: number
  rework_percentage: number
  rework_time_ratio: number
  setup_time_ratio: number
  total_setup_time: number
  buffer_blocked_ratio: number
  buffer_blocked_time: number
  buffer_capacity: number
  buffer_discipline: string
  completed_jobs: number
  throughput: number
  busy_time: number
  avg_block_time: number
  failure_breakdowns: number
  pm_breakdowns: number
  operator_per_station: number
  capacity: number
  top_bottleneck_type: string | null
  top_bottleneck_metric: string | null
}

export interface RunDetail {
  id: number
  scenario_id: number
  status: RunStatus
  created_at: string
  completed_at: string | null
  completed_jobs: number | null
  in_progress_jobs: number | null
  simulation_time: number | null
  num_replications: number | null
  error_message: string | null
  station_stats: StationStat[]
  result: Record<string, unknown> | null

  // Pre-computed KPIs from backend
  kpi_throughput: number | null
  kpi_avg_utilization: number | null
  kpi_peak_utilization: number | null
  kpi_bottleneck_station: string | null
  kpi_stations_at_risk: number | null
  kpi_total_failures: number | null
  kpi_avg_rework_pct: number | null
  kpi_sim_days: number | null
}

// ─── Insights ────────────────────────────────────────────────────────────────

export interface InsightItem {
  type: string
  priority: 'high' | 'medium' | 'low'
  title: string
  insight: string
  recommendation: string
  impact: string
  timeframe: string
  confidence: number
}

export interface InsightsResponse {
  run_id: number
  insights: {
    strategic_recommendations: InsightItem[]
    operational_insights: InsightItem[]
    predictive_analysis: InsightItem[]
    optimization_opportunities: InsightItem[]
    risk_assessment: InsightItem[]
    ai_confidence: number
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResponse {
  stations: Record<string, StationConfig>
  operators: Record<string, OperatorConfig>
  processflow: Record<string, ProcessStep[]>
  variant_quantities: Record<string, number>
  variant_intervals?: Record<string, number>
  setup_matrix?: Record<string, Record<string, number>>
  simulation_config?: Partial<SimConfig>
}

// ─── Canvas node types ───────────────────────────────────────────────────────

export interface StationNodeData {
  label: string
  // Set once from the palette item used to create this node (Station/Assembly/
  // Inspection/Packaging). Kept separate from `label` so renaming a station
  // doesn't lose its type-specific fields (e.g. Assembly Count).
  stationType?: string
  capacity: number
  cycleTime: number
  operators: number
  // Which of the day's shifts (1, 2, 3) this station runs on — any
  // combination, not just a contiguous count (e.g. [2, 3] to skip shift 1).
  shiftsPerDay?: number[]
  // Per-shift-number override of which weekdays THIS station runs that
  // shift on (Monday=0 ... Sunday=6), keyed by shift number. Absent for a
  // given shift number falls back to the scenario's global Shift Calendar
  // for that shift — this only holds entries where a station's own
  // calendar genuinely differs from the global one.
  workingDaysByShift?: Record<number, number[]>
  // Per-shift-number override of THIS station's start/end hour for that
  // shift (e.g. { 1: { start: 8, end: 16 } } for an 8am-4pm Shift 1),
  // independent of the scenario's global Shift Calendar hours for that
  // shift number. Absent for a given shift number falls back to the global
  // hours.
  shiftHoursByShift?: Record<number, { start: number; end: number }>
  // Per-shift-number override of THIS station's break windows for that
  // shift, independent of the scenario's global breaks for that shift
  // number. Absent for a given shift number falls back to the global
  // breaks; an explicit empty array means "no breaks for this station on
  // this shift", not "unset".
  breaksByShift?: Record<number, { start: number; duration: number }[]>
  assemblyCount?: number
  // Minutes for a unit to travel the length of a Conveyor. Used instead of
  // cycleTime for Conveyor stations, since transport is wall-clock travel
  // time rather than work that operators share.
  transportTime?: number
  // "Assembly type/table" — quantity of each upstream station's output needed
  // to produce one assembled unit here, keyed by the upstream station's base name.
  assemblyInputs?: Record<string, number>
  routingMode?: 'round_robin' | 'percentage' | 'condition' | 'shortest_queue'
  routingWeights?: Record<string, number>
  routingRules?: { variantType: string; resource: string }[]
  routingDefault?: string
}
