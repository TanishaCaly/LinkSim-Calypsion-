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
  // A Workplace/Station wired downstream of a Worker Controller names that
  // Controller here — the engine draws its operator from that Controller's
  // live pool (backend/engine/worker_pool.py) instead of the static
  // shift1/2/3 assignment below. Absent means no pool wired (unchanged
  // static behaviour, every pre-existing scenario).
  'Worker Controller'?: string
  // The rest of these fields are only present on a Worker Controller's own
  // entry — its dispatch settings, built by Canvas at save time. See
  // worker_pool.py's WorkerPool for exactly how each is used.
  'Pool Workers'?: { name: string; availability: number; travel_time: number }[]
  'Enabled'?: boolean
  'Assignment Strategy'?: 'first_available' | 'round_robin'
  'Queue Policy'?: 'queue' | 'reject'
  'Max Queue Size'?: number
  'Shift Start'?: number
  'Shift End'?: number
  'Allow Overtime'?: boolean
  'Use Worker Travel Time'?: boolean
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
  avg_cycle_time: number
}

// Per Worker Controller, from worker_pool.py's WorkerPool.get_stats() —
// reaches the frontend via RunDetail.result.worker_pool_stats (run.result is
// persisted and returned wholesale, so this needed no backend API change).
export interface WorkerPoolStat {
  workers_busy: number
  workers_idle: number
  queue_length: number
  jobs_completed: number
  jobs_rejected: number
  avg_wait_time: number
  worker_utilization: number
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
  result: (Record<string, unknown> & { worker_pool_stats?: Record<string, WorkerPoolStat> }) | null

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
  // Display-only fields shown alongside Cycle Time on the Station panel —
  // not yet read by the simulation engine (Cycle Time keeps feeding the
  // engine's process duration exactly as before). setupTime saves to the
  // scenario's existing 'Setup time' station field.
  setupTime?: number
  processTime?: number
  // Which of the day's shifts (1, 2, 3) this station runs on — any
  // combination, not just a contiguous count (e.g. [2, 3] to skip shift 1).
  shiftsPerDay?: number[]
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
  // Worker only — which named operator (a key in the scenario's
  // operators_data) this node represents. Contributes that operator's
  // Availability into the Worker Controller's pool it's wired to (Canvas.tsx's
  // save mutation) — see worker_pool.py.
  assignedOperator?: string
  // Worker only — minutes this Worker takes to move to a DIFFERENT
  // Workplace than the one it was last dispatched to. No cost when its
  // Worker Controller reassigns it to the SAME Workplace as last time.
  travelTime?: number
  // Worker only — which of its Worker Controller's controllerTasks (by id)
  // this Worker is assigned to (a Worker can hold more than one task at
  // once), chosen from the Controller panel's combined Workers/Tasks table.
  // Purely a UI assignment, not read by the engine.
  assignedTaskIds?: string[]
  // Worker only — free-text task descriptions typed directly into the
  // Worker Controller panel's Workers & Tasks row (e.g. "blank space to
  // write the task" from the company's Excel template). A Worker can hold
  // more than one, added via the row's "+" button. UI-only, not read by
  // the engine.
  taskTexts?: string[]
  // Worker only — which specific Workplace(s) (by node id) this Worker
  // actually serves, chosen from the Worker panel's Workplaces picker.
  // Independent of the Controller-level Workplace wiring: two Workers can
  // share one Worker Controller pool while each still only lists the
  // Workplace(s) relevant to them. UI-only, not read by the engine (the
  // engine only sees the shared pool via the Controller).
  assignedWorkplaceIds?: string[]
  // Worker Controller only — the dispatch brain's own settings (see
  // worker_pool.py's WorkerPool for exactly how each is used). Written onto
  // the Controller's own stations_data entry at save time, alongside the
  // Pool Workers list built from every Worker wired into it.
  controllerEnabled?: boolean
  assignmentStrategy?: 'first_available' | 'round_robin'
  queuePolicy?: 'queue' | 'reject'
  maxQueueSize?: number
  shiftStart?: number
  shiftEnd?: number
  allowOvertime?: boolean
  useWorkerTravelTime?: boolean
  // Worker Controller only — demo task checklist shown in the panel (not
  // read by the simulation engine; purely a UI list for now).
  controllerTasks?: { id: string; label: string; done: boolean }[]
  // Plain station only — purely a UI convenience flag: checking it in the
  // property panel auto-creates a Workplace node wired Station -> Workplace
  // (see Canvas.tsx's addWorkplaceFor). Not read at save time; the actual
  // staffing is the Workplace node/edges it created, same as if a user had
  // dragged one in by hand.
  requiresWorker?: boolean
}
