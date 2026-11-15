// ─── Scenario ────────────────────────────────────────────────────────────────

export interface StationConfig {
  capacity: number
  // Legacy count (1/2/3, meaning "shifts 1..N") from the Stations tab, OR an
  // explicit list of active shift numbers (e.g. [2, 3]) from the Canvas
  // Build panel's per-station shift picker — the engine accepts both.
  shifts_per_day: number | number[]
  operator_per_station: number
  'Station Type'?: string
  // A machine of a parallel group: the group's name (e.g. "Station 2" for
  // Station 2 #1, #2, #3). The group's machines share one waiting line.
  'Parallel Group'?: string
  // Start (Source) only — its MU table (see MuRow). Product, Number and
  // Interval are the scenario's own variants / quantities / intervals; only
  // Name is kept here alone.
  'MU Table'?: MuRow[]
  // Start (Source) only — its Exit Controller (see StationNodeData.muStrategy).
  'MU Strategy'?: 'cyclic' | 'random' | 'successor' | 'percentage'
  'MU Priorities'?: Record<string, number>
  'MU Percentages'?: Record<string, number>
  // Conveyor only — minutes to traverse the belt. Older scenarios only; the
  // engine uses it when there is no Conveyor Speed.
  'Transport Time'?: number
  // Conveyor only — belt speed (m/min). Transport time = Length / Speed.
  'Conveyor Speed'?: number
  // Exit Controller (station with 2+ next stations) — UI only, not read by
  // the engine yet.
  'Exit Strategy'?: 'cyclic' | 'random' | 'successor' | 'percentage'
  'Exit Percentages'?: Record<string, number>
  'Exit Priorities'?: Record<string, number>
  // Route by product: product -> the next stations it may go to.
  'Route By Product'?: boolean
  'Product Routes'?: Record<string, string[]>
  // Conveyor only. Length (with Speed) sets the transport time and Capacity
  // the jobs on the belt at once; Width/Height are display only.
  'Conveyor Length'?: number
  'Conveyor Width'?: number
  'Conveyor Height'?: number
  'Conveyor Capacity'?: number
  // Conveyor sensor (record only) — m from the belt's start ('Front') or
  // end ('Rear'). Absent = no sensor.
  'Conveyor Sensor Length'?: number
  'Conveyor Sensor Position'?: 'Front' | 'Rear'
  // Assembly station's settings pop-up (UI only for now).
  'Assembly'?: AssemblyConfig
  // Dismantle station settings (see DismantleConfig).
  'Dismantle'?: DismantleConfig
  'Failure rate': number
  'Repair Time': number
  // What happens to a part already in progress when this station's machine
  // fails mid-operation (backend/engine/machine.py's FailurePolicy enum):
  // 'resume' | 'restart' | 'scrap'. Absent means 'resume', same as the
  // engine's own default.
  'Failure Policy'?: string
  'Setup time': number
  'Buffer Capacity': number
  // When true, Buffer Capacity's number is ignored and the queue is
  // unlimited — lets 'Buffer Capacity': 0 mean a literal zero-room cap
  // (strict lockstep) instead of overloading 0 as "unlimited", matching how
  // Failure rate/Repair Time already treat 0 as a plain literal value.
  'Buffer Unlimited'?: boolean
  'Buffer Discipline': string
  // Canvas Build-mode only — never set by an Excel/CSV import. '3D' swaps
  // the single Buffer Capacity number for X/Y/Z lane dimensions below,
  // each defaulting to 1 until the user edits them on the canvas.
  'Buffer Config Mode'?: '2D' | '3D'
  'Buffer X'?: number
  'Buffer Y'?: number
  'Buffer Z'?: number
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

export interface ProcessStep {
  operation: string
  // A plain station name. Scenarios saved while the Exit Controller existed
  // may still hold a {mode, options, ...} dict here — only its first option
  // is used (see sim_core.py's _resolve_step_resource).
  resource: string | { options?: string[] }
  duration: number
  // Consecutive steps with the same branch number are one split: a job
  // visits only ONE of them, picked by the previous station's Exit
  // Controller. Absent on a plain step.
  branch?: number
  // A Buffer at the end of a line with no End: parts stay in it (it can
  // fill up and block the station before it) and count as finished.
  holds_parts?: boolean
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
  // The Build canvas drawing as last saved; null/absent until a scenario is
  // saved from the Canvas.
  canvas_layout?: CanvasLayout | null
}

// The Build canvas drawing: every box with a fixed id (SRC-1, STN-3, ...),
// its name, type and position, and every line with the products whose
// route uses it. One drawing for the whole scenario; Canvas-only — the
// engine reads stations_data / processflow_data.
export interface CanvasLayoutBox {
  id: string
  name: string
  type: string
  x: number
  y: number
  // The box's Canvas settings; for a real station, stations_data wins.
  data?: Partial<StationNodeData>
}

export interface CanvasLayoutLine {
  from: string
  to: string
  // Flow lines only (Worker wiring has none).
  products?: string[]
  label?: string
}

export interface CanvasLayout {
  version: 1
  boxes: CanvasLayoutBox[]
  lines: CanvasLayoutLine[]
  // Each product's route (its shape) when this drawing was saved — a route
  // changed on the Scenario page since then gets its lines drawn again.
  routes?: Record<string, string>
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
  canvas_layout?: CanvasLayout
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
  // Only set for a Buffer node in 3D mode (see backend's _init_rack_buffers)
  // — null/absent for every 2D/scalar station, meaning buffer_capacity
  // above is the real, active number for that one instead.
  rack_lane_count?: number | null
  rack_occupied?: number | null
  completed_jobs: number
  throughput: number
  busy_time: number
  avg_block_time: number
  failure_breakdowns: number
  failure_counts_per_machine?: number[]
  pm_breakdowns: number
  operator_per_station: number
  capacity: number
  // Conveyor only (m, m/min, min) — null for every other station.
  conveyor_length?: number | null
  conveyor_speed?: number | null
  transport_time?: number | null
  // Jobs that passed the conveyor's sensor — null when it has no sensor.
  sensor_passed?: number | null
  top_bottleneck_type: string | null
  top_bottleneck_metric: string | null
  avg_cycle_time: number
  max_cycle_time: number
}

// Per Worker Controller, from worker_pool.py's WorkerPool.get_stats() —
// reaches the frontend via RunDetail.result.worker_pool_stats (run.result is
// persisted and returned wholesale, so this needed no backend API change).
// One Worker of a Worker Controller's pool: the time it worked (minutes,
// from starting a job — walking left out — until released), jobs done, the
// share of the run it worked, and the same per station.
export interface WorkerStat {
  name: string
  worked_time: number
  jobs: number
  utilization: number
  workplaces: { station: string; worked_time: number; jobs: number }[]
  // Working / Free % of its available time (the Worker Controller's shift
  // minus the time it was away, after the warm-up); absent on older runs.
  working_pct?: number
  free_pct?: number
  available_time?: number
}

// A working station's statistical analysis (run.result.station_states):
// % of its operating time (shift time minus breaks and PM) in each state —
// the five add up to 100.
export interface StationStateStat {
  working: number
  free: number
  setup: number
  blocked: number
  failed: number
  operating_time: number
  // Parts on the machine(s) at the end of the run; completed (good) and
  // scrapped after the warm-up; Dismantle only: its output components.
  // Absent on runs made before these were recorded.
  current_parts?: number
  completed_parts?: number
  scrapped_parts?: number
  output_components?: number | null
}

// A Buffer's statistical analysis (run.result.buffer_states): % of its
// operating time it was Empty, Occupied (parts, room for more) or Full — 100.
export interface BufferStateStat {
  empty: number
  occupied: number
  full: number
  operating_time: number
  // Parts, as for a station: in the buffer at the end of the run, left it
  // after the warm-up, scrap (always 0). Absent on runs made before.
  current_parts?: number
  completed_parts?: number
  scrapped_parts?: number
}

// Parts delivered by each Start (Start -> product -> count) and collected at
// the line's end (last station before the End -> the route's product -> the
// part's name, e.g. Car -> count), after the warm-up (run.result.parts_flow).
export interface PartsFlow {
  delivered: Record<string, Record<string, number>>
  collected: Record<string, Record<string, Record<string, number>>>
}

export interface WorkerPoolStat {
  // Absent on runs made before worked time was recorded.
  workers?: WorkerStat[]
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

// One row of a Start's MU table: product (MU), how many (Number), display
// name, minutes between its jobs (Interval; empty = all at once), colour.
// Dismantle station settings, as in Tecnomatix's DismantleStation
// Attributes tab. Saved with the scenario (as 'Dismantle'). The simulation
// uses Sequence and Exiting FE; Dismantle Mode and Main FE to Successor make
// no difference yet.
export interface DismantleConfig {
  // Where the dismantled FEs go: to all successors, or as the Dismantle
  // input configuration says.
  sequence: 'all_successors' | 'input_config'
  mode: 'create_fe' | 'detach_fe'
  // The successor (1, 2, ...) the main FE goes to.
  mainFeToSuccessor: number
  // The pieces' name: the part's own (Main FE), or the New FE name.
  exitingFe: 'main_fe' | 'new_fe'
  // New FE only: its name (empty: the part's name + " A").
  newFeName?: string
  // Sequence = Dismantle input configuration: the Dismantle table, one row
  // per line leaving the Dismantle (absent: the defaults).
  table?: DismantleRow[]
  // Written on Save for the simulation: the stations its lines go to, in
  // the order connected (successor 1, 2, ...).
  successors?: string[]
}

// One row of the Dismantle table: how many pieces go to its station, and its
// Successor: the order the rows' pieces leave in (1 first). Their name comes
// from Exiting FE.
export interface DismantleRow {
  to: string        // the station the row's line goes to
  number: number
  successor: number
}

// Assembly station settings, as in Tecnomatix's AssemblyStation Attributes
// tab. Only the options seen so far are listed; more come later.
// 'mu_types' is shown as "Flow Entity(FE)". The last two are no longer
// offered (an older saved one opens as None).
export type AssemblyTableKind = 'none' | 'predecessors' | 'mu_types' | 'depends_on_main_mu' | 'fillup_main_mu'

// One row of the Assembly Table: Predecessors mode fills `predecessor`,
// Flow Entity(FE) mode fills `mu`. Assembly Time in minutes; Sequence Number optional.
export interface AssemblyTableRow {
  predecessor?: number
  mu?: string
  amount: number
  // Flow Entity(FE) rows only.
  assemblyTime?: number
  sequenceNumber?: number | null
}

// One line coming into an Assembly: its No. ("Main FE from predecessor"
// points at one) and how many of its parts make one assembly.
export interface AssemblyNeed {
  from: string      // the station the line comes from
  // Set by the user (Assembly needs); absent: the order the line was
  // connected. Always set in lines.
  no?: number
  amount: number
}

export interface AssemblyConfig {
  table: AssemblyTableKind
  mainMuFromPredecessor: number
  // Ticked = the default, predecessor 1 (absent: ticked when it is 1).
  mainMuDefault?: boolean
  mode: 'delete_mus' | 'attach_mus'
  // What leaves the assembly ("Assembled FE"): the main part, or a new one.
  exitingMu: 'main_mu' | 'new_fe'
  // New FE only: the name of the new product made by joining the parts.
  newFeName?: string
  // Assembly needs: one entry per incoming line (absent: No. in the order connected, amount 1).
  needs?: AssemblyNeed[]
  // Written on Save for the simulation: every line coming in, with its No.
  // (Predecessors: as set in Assembly needs; otherwise the order connected) and
  // amount (Predecessors only; otherwise 1).
  lines?: AssemblyNeed[]
  // Kept apart so switching between the two doesn't lose either table.
  predecessorRows: AssemblyTableRow[]
  muTypeRows: AssemblyTableRow[]
}

export interface MuRow {
  mu: string
  number: number
  name: string
  interval?: number | null
  // The product's colour (its jobs on the Canvas); none = a default colour.
  color?: string
}

export interface StationNodeData {
  // The station name this box's settings were saved under — set when a
  // saved scenario is loaded onto the Canvas, so Save still finds them
  // after the box is renamed. Absent on a box added on the Canvas.
  savedName?: string
  label: string
  // Set on every machine of a parallel group (Station 2 #1, #2, ...): the
  // group's name. Each machine is then a station of its own, saved under
  // its box's name — so it can be renamed and still stay in the group.
  parallelGroup?: string
  // A box pasted on the Canvas: the station it was copied from, whose saved
  // settings it starts with.
  copiedFrom?: string
  // Start (Source) only — the MU table: one row per product (variant) the
  // Start creates (see MuTableDialog).
  // Start (Source) only — its Exit Controller: the order the products are
  // released in, each product as one whole batch. Percentage is UI only.
  muStrategy?: 'cyclic' | 'random' | 'successor' | 'percentage'
  muPriorities?: Record<string, number>
  muPercentages?: Record<string, number>
  muTable?: MuRow[]
  // Set once from the palette item used to create this node (Station/Assembly/
  // Inspection/Packaging). Kept separate from `label` so renaming a station
  // doesn't lose its type-specific fields (e.g. Assembly Count).
  stationType?: string
  capacity: number
  // Process Time (min): the time the machine works on one job. Saved as the
  // route step's duration, which the engine uses as-is. (Cycle Time is a
  // result — wait + setup + process + blocked — never an input.)
  processTime: number
  operators: number
  // Saves to the scenario's existing 'Setup time' station field.
  setupTime?: number
  // Minutes to fix this station after a breakdown (MTTR). Saves to the
  // scenario's existing 'Repair Time' station field — previously only
  // editable outside Canvas (Excel import or the ScenarioManager grid),
  // which meant a Canvas-built scenario always saved a hardcoded 10
  // regardless of what the user actually wanted.
  repairTime?: number
  // What happens to a part already in progress when this station's machine
  // fails mid-operation: 'resume' (continue the remaining time after
  // repair — the default), 'restart' (redo the full operation from
  // scratch), or 'scrap' (the part is discarded). Saves to the scenario's
  // 'Failure Policy' station field (backend/engine/machine.py's
  // FailurePolicy enum); unset defaults to 'resume' there too.
  failurePolicy?: string
  // Which of the day's shifts (1, 2, 3) this station runs on — any
  // combination, not just a contiguous count (e.g. [2, 3] to skip shift 1).
  shiftsPerDay?: number[]
  // The box's fixed id in the saved drawing (canvas_layout), e.g. "STN-3".
  // Given on its first save; never changes, even when the box is renamed.
  boxId?: string
  // Assembly only — its settings pop-up (Tecnomatix's Attributes tab).
  // UI only for now; the simulation doesn't read it yet. Saved as 'Assembly'.
  assembly?: AssemblyConfig
  // Dismantle only — its settings (Tecnomatix's Attributes tab). Saved as
  // 'Dismantle'; see DismantleConfig for what the simulation uses.
  dismantle?: DismantleConfig
  // Conveyor belt speed (m/min). Its transport time is conveyorLength /
  // conveyorSpeed, used instead of processTime for Conveyor stations.
  conveyorSpeed?: number
  // Conveyor dimensions (m) and capacity (units). Width/Height are display only.
  conveyorLength?: number
  conveyorWidth?: number
  conveyorHeight?: number
  conveyorCapacity?: number
  // Conveyor sensor — m from the belt's start ('front') or end ('rear').
  // Saved as 'Conveyor Sensor Length' / 'Conveyor Sensor Position'.
  conveyorSensor?: { length: number; position: 'front' | 'rear' }
  // Exit Controller — how finished jobs are split across 2+ next stations.
  // UI/storage only for now; the simulation engine doesn't read it yet.
  exitStrategy?: 'cyclic' | 'random' | 'successor' | 'percentage'
  exitPercentages?: Record<string, number>  // keyed by next station's base name
  exitPriorities?: Record<string, number>   // Successor mode: next box label -> priority (1 = first)
  // Route by product: when on, each product may only go to
  // the next stations ticked for it (product -> next box labels); the Exit
  // Controller then picks among those.
  routeByProduct?: boolean
  productRoutes?: Record<string, string[]>
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
  // Buffer only — Build-mode config, saved to the scenario's 'Buffer
  // Capacity' / 'Buffer Unlimited' / 'Buffer Config Mode' / 'Buffer X/Y/Z' /
  // 'Buffer Discipline' station fields (see Canvas.tsx's Buffer panel).
  bufferQuantity?: number
  bufferUnlimited?: boolean
  bufferConfigMode?: '2D' | '3D'
  bufferX?: number
  bufferY?: number
  bufferZ?: number
  bufferOrder?: 'FIFO' | 'LIFO'
}
