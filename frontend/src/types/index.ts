// ─── Scenario ────────────────────────────────────────────────────────────────

export interface StationConfig {
  capacity: number
  shifts_per_day: number
  operator_per_station: number
  'Station Type'?: string
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
  assemblyCount?: number
  // "Assembly type/table" — quantity of each upstream station's output needed
  // to produce one assembled unit here, keyed by the upstream station's base name.
  assemblyInputs?: Record<string, number>
  routingMode?: 'round_robin' | 'percentage' | 'condition' | 'shortest_queue'
  routingWeights?: Record<string, number>
  routingRules?: { variantType: string; resource: string }[]
  routingDefault?: string
}
