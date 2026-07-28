"""
ManufacturingSimulation — adapted from UpdatedSimulationProject/models/ManufacturingSimulation.py
and Simul8_app_rep/simulation/des_runner.py.

Key changes from originals:
  - All st.session_state / Dash store references removed
  - Results returned as plain dicts, not written to framework state
  - Progress reported via optional callback(pct: float, msg: str)
  - Statistical replications integrated from des_runner.py
  - _perform_operation split into readable sub-methods
"""
import logging
import simpy
import random
import statistics as stats_lib
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple

from .machine import Machine
from .formulas import (
    calc_station_throughput, build_summary,
    calc_station_utilization, calc_operator_utilization,
    calc_rework_pct, calc_rework_time_ratio, calc_setup_time_ratio,
    calc_buffer_blocked_ratio, calc_avg_block_time, calc_time_percentages,
)
from .sim_utils import SimulationUtils
from .bottleneck import identify_bottlenecks, calculate_affected_jobs, event_analyse

logger = logging.getLogger("linksim.engine")

# Safety guardrail: the longest simulated horizon we allow in a single run.
# 525600 minutes = 1 year (also the frontend's max). Requests above this are
# clamped (with a warning) so a runaway value can't make a run effectively
# never terminate.
MAX_SIM_TIME = 525_600.0


def _format_job_id(variant_type: str, variant_id: int) -> str:
    """
    Stable, human-readable job identifier — e.g. "ProductA-003" — derived
    from the same (variant_type, variant_id) pair already used internally
    as the job_log/completion_log key, just formatted for display instead
    of the raw "producta 3" dict-key form.
    """
    clean_type = "".join(ch for ch in variant_type if ch.isalnum()) or variant_type
    return f"{clean_type}-{variant_id:03d}"


def _determine_delay_reason(
    blocked_time: float,
    station_downtime: float,
    operator_downtime: float,
    setup_time: float,
    material_unavailable: float,
    rework_time: float,
) -> str:
    """
    Attribute a single, dominant delay reason to one job's visit to one
    station, by comparing the actual duration of each already-tracked delay
    signal — the same signals other DES tools require a manual cross-
    reference to derive (see the Job Trace feature's research notes), here
    computed automatically per job rather than left as a station-wide
    aggregate or a manual exercise for the user.

    Priority is by MAGNITUDE, not a fixed rule order — whichever single
    signal cost this job the most time at this station is reported, since
    that's the one an engineer would actually want to act on. A tie falls
    through to the earlier-listed (higher-priority) reason.
    """
    candidates = [
        (station_downtime, "Machine breakdown"),
        (operator_downtime, "Waiting for operator"),
        (material_unavailable, "Waiting for material"),
        (setup_time, "Changeover in progress"),
        (rework_time, "Rework"),
        (blocked_time, "Waiting in queue — station busy"),
    ]
    duration, reason = max(candidates, key=lambda c: c[0])
    return reason if duration > 0 else "No delay"


class RackBuffer:
    """
    Physical X/Y/Z buffer: Width * Height lanes, each a Depth-deep stack —
    like a real gravity-flow pallet rack. Unlike a plain scalar Buffer
    Capacity (a single count with no internal structure), a job placed
    behind another one in the same lane is physically stuck: it cannot be
    picked until everything in front of it in that lane is removed, even if
    OTHER lanes have free slots or ready-to-pick items. This is the one
    behaviour a scalar buffer structurally cannot express.

    Placement: round-robin across lanes — a new job goes into whichever
    lane currently has the most free depth remaining (ties broken by lane
    index), so lanes fill evenly rather than one lane filling completely
    before the next is used.

    Retrieval: only the front (oldest) item of each lane is ever pickable.
    "get" scans all lanes and returns the one with the longest-waiting front
    item, so multiple ready lanes are still served oldest-first overall.
    """

    def __init__(self, width: int, depth: int, height: int):
        self.width = max(1, width)
        self.depth = max(1, depth)
        self.height = max(1, height)
        self.lane_count = self.width * self.height
        # Each lane is a list acting as a physical stack: index 0 = front
        # (pickable), last index = back (most recently placed).
        self.lanes: List[List[Any]] = [[] for _ in range(self.lane_count)]

    @property
    def total_capacity(self) -> int:
        return self.lane_count * self.depth

    @property
    def occupied(self) -> int:
        return sum(len(lane) for lane in self.lanes)

    def has_room(self) -> bool:
        return any(len(lane) < self.depth for lane in self.lanes)

    def put(self, token: Any) -> int:
        """Place into whichever lane has the most free depth (round-robin fill). Returns the lane index used."""
        candidates = [i for i in range(self.lane_count) if len(self.lanes[i]) < self.depth]
        if not candidates:
            raise RuntimeError("RackBuffer.put() called with no room — caller must check has_room() first")
        best = max(candidates, key=lambda i: self.depth - len(self.lanes[i]))
        self.lanes[best].append(token)
        return best

    def ready_lane(self) -> Optional[int]:
        """Index of a lane whose front slot is occupied (has something pickable), or None."""
        for i, lane in enumerate(self.lanes):
            if lane:
                return i
        return None

    def get(self) -> Any:
        """Remove and return the front item of a ready lane (physical pick)."""
        i = self.ready_lane()
        if i is None:
            raise RuntimeError("RackBuffer.get() called with nothing ready — caller must check ready_lane() first")
        return self.lanes[i].pop(0)

    def get_from_lane(self, lane_idx: int) -> Any:
        """Remove and return the front item of a specific lane (used once a
        caller has confirmed its own token is that lane's front item)."""
        return self.lanes[lane_idx].pop(0)


# ---------------------------------------------------------------------------
# Result dataclass (plain dict for JSON-friendliness)
# ---------------------------------------------------------------------------

def _empty_result() -> Dict:
    return {
        "completed_jobs": 0,
        "station_utilization": {},
        "operator_utilization": {},
        "job_log": {},
        "completion_log": {},
        "bottleneck_store": {},
        "error": None,
    }


# ---------------------------------------------------------------------------
# Main simulation class
# ---------------------------------------------------------------------------

class ManufacturingSimulation:
    """
    Discrete-event manufacturing simulation engine.

    Inputs
    ------
    stations_data       : dict  – station config (capacity, shifts, operators, failure_rate …)
    processflow_data    : dict  – variant → list of {operation, resource, duration}
    variant_quantities  : dict  – variant → qty to produce
    operators_data      : dict  – operator → {Skill Rating, Availability (%)}
    simulation_config   : dict  – SIM_TIME, SHIFT_DURATION, SHIFT_n_START/END, STATION_DOWNTIME
    progress_callback   : optional callable(pct: float, msg: str, **extra)

    Returns (via .run())
    --------------------
    dict with keys: job_log, completion_log, bottleneck_store, station_stats, simulation_state
    """

    def __init__(
        self,
        stations_data: Dict[str, Any],
        processflow_data: Dict[str, List[Dict]],
        variant_quantities: Dict[str, int],
        operators_data: Dict[str, Any],
        simulation_config: Dict[str, Any],
        progress_callback: Optional[Callable[..., None]] = None,
        variant_intervals: Optional[Dict[str, float]] = None,
        setup_matrix: Optional[Dict[str, Dict[str, float]]] = None,
    ):
        self.stations_data = {k: dict(v) for k, v in stations_data.items()}
        self.processflow_data = processflow_data
        self.variant_quantities = variant_quantities
        # Minutes between successive job arrivals per variant (fixed/deterministic
        # spacing). A variant absent from this dict falls back to the original
        # behaviour: all its jobs spawn immediately at t=0.
        self.variant_intervals = variant_intervals or {}
        # Optional per-station product-pair changeover matrix — {station:
        # {"from|to": minutes}}. A station/pair absent here falls back to that
        # station's flat "Setup time" column (existing behaviour, unchanged).
        self.setup_matrix = setup_matrix or {}
        self.operators_data = operators_data
        self.sim_config = simulation_config
        self.progress_cb = progress_callback or (lambda pct, msg, **extra: None)

        # Runtime state (reset on each run)
        self.env: Optional[simpy.Environment] = None
        self.resources: Dict[str, Machine] = {}
        self.job_log: Dict[str, List] = {}
        self.completion_log: Dict[str, List] = {}
        self.bottleneck_store: Dict[str, Any] = {}
        self.simulation_state: Dict[str, Any] = {}
        self.cycle_times: Dict[str, float] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self) -> Dict[str, Any]:
        """Execute the simulation and return results."""
        self._validate_config()
        self._reset_state()
        self._run_simpy()

        # KPIs (utilization, throughput) are computed against the
        # steady-state window only — SIM_TIME minus WARMUP_TIME — since
        # busy_time/completed_jobs were only accumulated from WARMUP_TIME
        # onward (see _perform_operation/_process_variant). Swap in the
        # measured-window duration for post-processing, then restore the
        # real SIM_TIME afterward so anything reporting the true simulated
        # horizon (e.g. RunDetail.simulation_time) is unaffected.
        full_sim_time = self.sim_config["SIM_TIME"]
        warmup_time = self.sim_config.get("WARMUP_TIME", 0) or 0
        self.sim_config["SIM_TIME"] = full_sim_time - warmup_time
        try:
            self._post_process()
            result = self._collect_results()
        finally:
            self.sim_config["SIM_TIME"] = full_sim_time
        return result

    def _validate_config(self):
        """
        Guardrail: reject obviously-invalid configs and clamp runaway horizons.

        - SIM_TIME must be a finite number > 0 (else the run can't terminate
          sensibly) → raise ValueError with a clear message.
        - SIM_TIME above MAX_SIM_TIME is clamped down (with a warning) rather
          than rejected, so the run still produces results.
        """
        import math

        sim_time = self.sim_config.get("SIM_TIME")
        try:
            sim_time = float(sim_time)
        except (TypeError, ValueError):
            raise ValueError(f"SIM_TIME must be a number, got {sim_time!r}")
        if not math.isfinite(sim_time) or sim_time <= 0:
            raise ValueError(f"SIM_TIME must be a finite positive number, got {sim_time!r}")

        if sim_time > MAX_SIM_TIME:
            logger.warning(
                "SIM_TIME %.0f exceeds MAX_SIM_TIME %.0f — clamping to the maximum.",
                sim_time, MAX_SIM_TIME,
            )
            sim_time = MAX_SIM_TIME
        self.sim_config["SIM_TIME"] = sim_time

        # WARMUP_TIME — an initial stretch of simulated minutes (measured from
        # t=0) during which jobs flow through the line as normal, but nothing
        # is counted toward busy_time/completed_jobs/KPIs. Lets the line fill
        # up from empty before steady-state stats start, same idea as Arena's
        # warm-up period. Defaults to 0 (off) so existing scenarios are
        # unaffected. Clamped to [0, SIM_TIME) — a warm-up >= SIM_TIME would
        # leave nothing to measure.
        warmup_time = self.sim_config.get("WARMUP_TIME", 0) or 0
        try:
            warmup_time = float(warmup_time)
        except (TypeError, ValueError):
            warmup_time = 0.0
        if not math.isfinite(warmup_time) or warmup_time < 0:
            warmup_time = 0.0
        if warmup_time >= sim_time:
            logger.warning(
                "WARMUP_TIME %.0f >= SIM_TIME %.0f — ignoring warm-up for this run.",
                warmup_time, sim_time,
            )
            warmup_time = 0.0
        self.sim_config["WARMUP_TIME"] = warmup_time

        total_jobs = sum(self.variant_quantities.values()) if self.variant_quantities else 0
        if total_jobs <= 0:
            logger.warning("No jobs to run (variant quantities sum to 0).")

    def run_with_replications(
        self,
        num_replications: int = 5,
        warmup_fraction: float = 0.1,
    ) -> Dict[str, Any]:
        """
        Run N independent replications and aggregate with 95% confidence intervals.
        Adapted from Simul8_app_rep/simulation/des_runner.py.
        """
        all_results: List[Dict] = []

        for rep in range(num_replications):
            self.progress_cb(rep / num_replications, f"Replication {rep + 1}/{num_replications}")
            random.seed(42 + rep)
            result = self.run()
            all_results.append(result)

        self.progress_cb(1.0, "Aggregating replications")
        return self._aggregate_replications(all_results)

    # ------------------------------------------------------------------
    # SimPy execution
    # ------------------------------------------------------------------

    def _resolve_start_date(self) -> datetime:
        """
        The real calendar date/time the simulation clock starts at (env.now=0
        maps to this). Anchors weekday-of-week logic (WORKING_DAYS_n) to real
        weekdays — e.g. so "Monday" in the shift calendar lines up with an
        actual Monday once a user picks a start date via the Simulation Timer.
        Falls back to the engine's original fixed default when unset, so
        scenarios saved before this field existed behave exactly as before.
        """
        raw = self.sim_config.get("SIMULATION_START_DATE")
        if raw:
            try:
                return datetime.fromisoformat(str(raw))
            except ValueError:
                logger.warning("Invalid SIMULATION_START_DATE %r — using default.", raw)
        return datetime(2025, 1, 1, 6, 0, 0)

    def _reset_state(self):
        self.env = simpy.Environment()
        self.job_log = {}
        self.completion_log = {}
        self.bottleneck_store = {}
        self.simulation_state = {
            "start_date": self._resolve_start_date(),
            "total_simulated_time": 0,
            "completed_jobs": 0,
            "in_progress_jobs": 0,
            "job_count": 0,
            "current_jobs": {},
            "running_jobs": [],
            "job_exit_times": {},
        }

        # Reset per-station tracking
        for station in self.stations_data.values():
            station.update({
                "busy_time": 0,
                "operator_busy_time": 0,
                "total_simulated_time_per_station": 0,
                "completed_jobs_per_station": 0,
                "total_block_time": 0,
                "job_wait_count": 0,
                "total_waiting_time": 0,
                "total_station_downtime": 0,
                "total_operator_downtime": 0,
                "total_rework_time": 0,
                "rework_events": 0,
                "operator_downtime_events": 0,
                "failure_breakdowns": 0,
                "pm_breakdowns": 0,
                "job_counts": {"waiting": 0, "processing": 0, "completed": 0},
            })

        self.cycle_times = self._compute_cycle_times()
        self.resources = self._init_resources()
        self.rack_buffers = self._init_rack_buffers()
        # Build case-insensitive/stripped lookup: normalized_key → original station key
        self._resource_key_map: Dict[str, str] = {
            k.lower().strip(): k for k in self.stations_data
        }
        # Per-station effective shift config: each station's own shift1/2/3
        # time-windows override the global SHIFT_n_START/END (falls back to
        # global when a station doesn't define a window).
        self._station_shift_cfg: Dict[str, Dict[str, Any]] = {
            name: SimulationUtils.build_station_shift_config(self.sim_config, st)
            for name, st in self.stations_data.items()
        }

    def _setup_time_for(self, resource_name: str, last_variant: Optional[str], variant_type: str) -> float:
        """
        Changeover time for switching `resource_name` from `last_variant` to
        `variant_type`. Looks up the optional per-station setup matrix
        ({"from|to": minutes}, keyed on lowercased variant names — see
        CsvParser.parse_setup_matrix) for a pair-specific time first; falls
        back to the station's flat "Setup time" column when no matrix entry
        covers this exact (from, to) pair, which also covers the common case
        of no matrix being defined at all (existing behaviour, unchanged).
        """
        if last_variant is not None:
            matrix = self.setup_matrix.get(resource_name)
            if matrix:
                key = f"{last_variant.lower()}|{variant_type.lower()}"
                if key in matrix:
                    return matrix[key]
        return self.stations_data[resource_name].get("Setup time", 0) or 0

    def _resolve_resource(self, raw_name: str) -> Optional[str]:
        """Return the canonical station key for raw_name, or None if not found."""
        if raw_name in self.stations_data:
            return raw_name
        normalized = raw_name.lower().strip()
        return self._resource_key_map.get(normalized)

    def _resolve_step_resource(self, step: Dict[str, Any], variant_type: str) -> Optional[str]:
        """
        Resolve a process-flow step's destination station. `step["resource"]`
        is either:
          - a plain string (today's behaviour, unchanged — single destination), or
          - a routing dict: {"mode": ..., "options": [...], ...} — "Exit
            controller type", used when a station's finished jobs can go to
            more than one possible next station.

        Modes (the standard set used by AnyLogic/FlexSim/Simul8/Arena):
          - "round_robin":     cycle through `options` in order (state is a
                                counter stored ON THE STEP DICT itself, which
                                is the same shared list object for every job
                                of this variant — so it persists correctly
                                across jobs, not reset per job).
          - "percentage":      weighted random pick via `weights` (parallel
                                to `options`) — converges to the target split
                                over many jobs; each pick is independent.
          - "condition":       ordered `rules` list of {"if": "<attr>==<val>",
                                "resource": "<name>"}, first match wins,
                                falling back to `default`. Only supports
                                simple `variant_type == "X"` equality checks.
          - "shortest_queue":  picks whichever candidate in `options`
                                currently has the fewest jobs waiting for its
                                machine — the one mode that needs live
                                simulation state at decision time rather than
                                a counter or fixed weights.
        """
        raw = step.get("resource")
        if isinstance(raw, str):
            return self._resolve_resource(raw)
        if not isinstance(raw, dict):
            return None

        mode = str(raw.get("mode", "round_robin")).strip().lower()
        options = [o for o in raw.get("options", []) if self._resolve_resource(o) is not None]
        if not options:
            return None

        if mode == "round_robin":
            idx = raw.get("_rr_index", 0) % len(options)
            raw["_rr_index"] = (idx + 1) % len(options)
            chosen = options[idx]
        elif mode == "percentage":
            weights = raw.get("weights") or [1] * len(options)
            chosen = random.choices(options, weights=weights, k=1)[0]
        elif mode == "condition":
            chosen = None
            for rule in raw.get("rules", []):
                cond = str(rule.get("if", ""))
                if "==" in cond:
                    lhs, _, rhs = cond.partition("==")
                    lhs, rhs = lhs.strip(), rhs.strip().strip("'\"")
                    if lhs == "variant_type" and variant_type == rhs:
                        chosen = rule.get("resource")
                        break
            if chosen is None:
                chosen = raw.get("default", options[0])
        elif mode == "shortest_queue":
            def _load(name: str) -> float:
                # Total load = jobs actively holding the machine (.count) +
                # jobs waiting for it (.queue) — checking .queue alone misses
                # a station that's busy-but-nobody-waiting-yet, which made
                # every job pick the same "empty queue" destination.
                resolved_name = self._resolve_resource(name)
                if resolved_name not in self.resources:
                    return float("inf")
                res = self.resources[resolved_name]
                return res.count + len(res.queue)
            chosen = min(options, key=_load)
        else:
            chosen = options[0]

        return self._resolve_resource(chosen)

    def _compute_cycle_times(self) -> Dict[str, float]:
        """Average duration per operation across all variants."""
        op_durations: Dict[str, List[float]] = defaultdict(list)
        for operations in self.processflow_data.values():
            for op in operations:
                op_durations[op["operation"]].append(op["duration"])
        return {
            op: sum(durs) / len(durs)
            for op, durs in op_durations.items()
            if durs
        }

    def _init_resources(self) -> Dict[str, Machine]:
        resources = {}
        for name, station in self.stations_data.items():
            resources[name] = Machine(
                env=self.env,
                name=name,
                failure_rate=station.get("Failure rate", 0),
                repair_time=station.get("Repair Time", 10),
                pm_schedule=station.get("PM Schedule"),
                capacity=station.get("capacity", 1),
                job_log=self.job_log,
                simulation_time=self.sim_config["SIM_TIME"],
            )
        return resources

    def _init_rack_buffers(self) -> Dict[str, RackBuffer]:
        """
        One RackBuffer per station that has Buffer Width/Depth/Height
        configured — takes precedence over the plain scalar Buffer Capacity
        for that station (see _process_variant's buffer hand-off). Stations
        without any of the three dimensions set simply have no entry here
        and fall back to the existing scalar/unlimited behaviour untouched.
        """
        buffers = {}
        for name, station in self.stations_data.items():
            width = station.get("Buffer Width", 0) or 0
            depth = station.get("Buffer Depth", 0) or 0
            height = station.get("Buffer Height", 0) or 0
            if width > 0 and depth > 0 and height > 0:
                buffers[name] = RackBuffer(int(width), int(depth), int(height))
        return buffers

    def _run_simpy(self):
        total_jobs = sum(self.variant_quantities.values())
        spawned = 0

        for variant, qty in self.variant_quantities.items():
            interval = self.variant_intervals.get(variant, 0) or 0
            for i in range(1, qty + 1):
                if interval > 0:
                    # Space this job's arrival out by (i-1) * interval minutes
                    # instead of spawning it immediately at t=0, so jobs of this
                    # variant enter the system on a fixed, predictable schedule.
                    self.env.process(self._delayed_spawn(i, variant, (i - 1) * interval))
                else:
                    self.env.process(self._process_variant(i, variant))
                spawned += 1
                self.progress_cb(spawned / total_jobs * 0.5, f"Scheduling {variant} #{i}")

        self.simulation_state["in_progress_jobs"] = total_jobs
        self.progress_cb(0.5, "Running simulation…")

        # Run in steps rather than one single env.run(until=SIM_TIME) call so
        # the simulation CLOCK's own progress (env.now vs SIM_TIME) can be
        # reported as it advances, not just the coarse pre/post-run phases
        # above and below. Each step behaves identically to one long
        # env.run() — SimPy resumes from wherever it left off — this only
        # adds checkpoints to report progress from, not different behavior.
        sim_time = self.sim_config["SIM_TIME"]
        num_steps = 100
        step = max(1.0, sim_time / num_steps)
        target = 0.0
        while target < sim_time:
            target = min(sim_time, target + step)
            self.env.run(until=target)
            # Second half of the progress bar (0.5-0.9) tracks simulated-time
            # completion; the remaining phases below still own 0.9-1.0.
            frac = target / sim_time if sim_time > 0 else 1.0
            self.progress_cb(
                0.5 + frac * 0.4,
                "Running simulation…",
                sim_time_now=target,
                sim_time_total=sim_time,
            )

        # Copy machine failure/PM counts back into station data
        for name, machine in self.resources.items():
            self.stations_data[name]["failure_breakdowns"] = machine.failure_count
            self.stations_data[name]["pm_breakdowns"] = machine.pm_count
            if machine.wait_start_time is not None:
                wait_end = self.env.now
                wait_dur = wait_end - machine.wait_start_time
                self.stations_data[name]["total_waiting_time"] = (
                    self.stations_data[name].get("total_waiting_time", 0) + wait_dur
                )

        self.simulation_state["total_simulated_time"] = self.env.now

    # ------------------------------------------------------------------
    # Variant process
    # ------------------------------------------------------------------

    def _delayed_spawn(self, variant_id: int, variant_type: str, delay: float):
        """Wait `delay` minutes (fixed inter-arrival spacing), then start the job."""
        if delay > 0:
            yield self.env.timeout(delay)
        yield from self._process_variant(variant_id, variant_type)

    def _process_variant(self, variant_id: int, variant_type: str):
        steps = self.processflow_data.get(variant_type, [])
        # Resolve each step's destination LAZILY, the first time it's needed
        # (either when the loop reaches it, or earlier via the buffer
        # look-ahead one step below) — cached in `resolved` so it's decided
        # exactly ONCE per job, not re-rolled. This must NOT happen all
        # upfront at job-spawn time: "shortest_queue" mode needs to see the
        # REAL simulation state at the moment the job actually reaches that
        # decision point, not at t=0 before any job has even started (every
        # candidate would tie at 0 load and always pick the first one).
        resolved: List[Optional[str]] = [None] * len(steps)

        def resolve(i: int) -> Optional[str]:
            if resolved[i] is None:
                resolved[i] = self._resolve_step_resource(steps[i], variant_type)
            return resolved[i]

        # Set by the PREVIOUS step's buffer hand-off when the next station has
        # a rack buffer — released only once this step's _perform_operation
        # actually secures the machine (see on_machine_acquired), so a rack
        # slot stays physically occupied for the job's whole wait, not just
        # the instant it became front-of-lane.
        pending_rack_release = None

        for idx, step in enumerate(steps):
            resource_name = resolve(idx)
            if resource_name is None:
                logger.warning(
                    "Resource for step '%s' not found in stations_data — skipping for %s#%s",
                    step.get("operation"), variant_type, variant_id,
                )
                continue
            durations = step.get("durations")
            release_cb = pending_rack_release
            pending_rack_release = None
            try:
                if isinstance(durations, list):
                    for i, duration in enumerate(durations):
                        yield from self._perform_operation(
                            resource_name, variant_id, variant_type,
                            step["operation"],
                            self.stations_data[resource_name].get("operator_per_station", 1),
                            self.stations_data[resource_name].get("shifts_per_day", 1),
                            duration,
                            on_machine_acquired=release_cb if i == 0 else None,
                        )
                else:
                    yield from self._perform_operation(
                        resource_name, variant_id, variant_type,
                        step["operation"],
                        self.stations_data[resource_name].get("operator_per_station", 1),
                        self.stations_data[resource_name].get("shifts_per_day", 1),
                        step["duration"],
                        on_machine_acquired=release_cb,
                    )
            except Exception as exc:
                logger.error(
                    "%s#%s at station '%s' op '%s': %s",
                    variant_type, variant_id, resource_name, step.get("operation"), exc,
                    exc_info=True,
                )
                # Continue to next step so job can still complete
                continue

            # --- Buffer hand-off: hold this job at resource_name until the
            # NEXT station has room to accept it. The job has already
            # finished processing here, so every minute spent waiting below
            # counts as this station being blocked (it can't start its next
            # job because it's still holding this finished one). Neither a
            # rack buffer nor a scalar Buffer Capacity configured on the next
            # station → unlimited, identical to behaviour before either
            # feature existed.
            if idx + 1 < len(steps):
                next_resource = resolve(idx + 1)
                if next_resource is not None:
                    rack = self.rack_buffers.get(next_resource)
                    if rack is not None:
                        # Physical X/Y/Z rack: enter a lane once one has room,
                        # then wait to become THAT SPECIFIC lane's front
                        # (pickable) item — a job stuck behind others in its
                        # own lane must wait them out even if other lanes are
                        # already free/ready, which is the whole point of the
                        # physical model over a plain scalar count. The slot
                        # itself is only released later, once the job actually
                        # secures the next station's machine (on_machine_acquired).
                        block_start = self.env.now
                        while not rack.has_room():
                            yield self.env.timeout(1)
                        token = object()
                        lane_idx = rack.put(token)
                        while rack.lanes[lane_idx][0] is not token:
                            yield self.env.timeout(1)
                        buffer_block = self.env.now - block_start
                        if buffer_block > 0:
                            self.stations_data[resource_name]["total_block_time"] = (
                                self.stations_data[resource_name].get("total_block_time", 0) + buffer_block
                            )
                            self.stations_data[resource_name]["buffer_blocked_time"] = (
                                self.stations_data[resource_name].get("buffer_blocked_time", 0) + buffer_block
                            )

                        def _make_release(r=rack, li=lane_idx):
                            def _release():
                                r.get_from_lane(li)
                            return _release
                        pending_rack_release = _make_release()
                    else:
                        cap = self.stations_data[next_resource].get("Buffer Capacity", 0) or 0
                        if cap > 0:
                            block_start = self.env.now
                            next_queue = self.resources[next_resource].queue
                            while len(next_queue) >= cap:
                                yield self.env.timeout(1)
                            buffer_block = self.env.now - block_start
                            if buffer_block > 0:
                                self.stations_data[resource_name]["total_block_time"] = (
                                    self.stations_data[resource_name].get("total_block_time", 0) + buffer_block
                                )
                                self.stations_data[resource_name]["buffer_blocked_time"] = (
                                    self.stations_data[resource_name].get("buffer_blocked_time", 0) + buffer_block
                                )

        self.simulation_state["total_simulated_time"] = self.env.now
        # Excluded from the headline "Completed Jobs" KPI during warm-up, same
        # as the per-station counters above — see _validate_config.
        if self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            self.simulation_state["completed_jobs"] += 1
        self.simulation_state["in_progress_jobs"] = max(
            0, self.simulation_state["in_progress_jobs"] - 1
        )
        self.simulation_state["job_count"] = self.simulation_state["completed_jobs"]

    # ------------------------------------------------------------------
    # Operation execution (core logic from ManufacturingSimulation._perform_operation)
    # ------------------------------------------------------------------

    def _perform_operation(
        self,
        resource_name: str,
        variant_id: int,
        variant_type: str,
        operation: str,
        num_operators: int,
        shifts_per_day: Any,
        duration: float,
        on_machine_acquired: Optional[Callable[[], None]] = None,
    ):
        resource = self.resources[resource_name]
        # A station with 0 assigned operators is machine-only / a queue-buffer:
        # it must NOT gate on operator availability (#7). Keep the raw count so
        # we can branch on it, but use >=1 for the cycle-time division.
        has_operators = bool(num_operators)
        num_operators = num_operators or 1
        adjusted_ct = duration / num_operators
        # Per-station shift schedule (honours the station's own shift windows;
        # falls back to the global config when the station defines none).
        shift_cfg = self._station_shift_cfg.get(resource_name, self.sim_config)
        start_date = self.simulation_state["start_date"]
        first_station = SimulationUtils.is_first_station(resource_name, self.processflow_data)

        variant_name = f"{variant_type} {variant_id}"
        if variant_name not in self.job_log:
            self.job_log[variant_name] = []

        # --- Handle machine idle (no jobs waiting) ---
        if resource.wait_start_time is not None:
            wait_end = self.env.now
            wait_dur = wait_end - resource.wait_start_time
            self.stations_data[resource_name]["total_waiting_time"] = (
                self.stations_data[resource_name].get("total_waiting_time", 0) + wait_dur
            )
            self._log_event(variant_name, resource_name, shifts_per_day, "waiting",
                            resource.wait_start_time, wait_end, waiting_time=wait_dur,
                            start_date=start_date)
            resource.wait_start_time = None

        self.stations_data[resource_name].setdefault("job_counts", {"waiting": 0, "processing": 0, "completed": 0})
        self.stations_data[resource_name]["job_counts"]["waiting"] += 1

        total_blocked = 0.0
        total_processing = 0.0
        total_station_dt = 0.0
        total_operator_dt = 0.0
        total_rework = 0.0
        total_pause = 0.0
        total_setup = 0.0
        material_unavail = 0.0
        station_downtime_budget = self.sim_config.get("STATION_DOWNTIME", 0)

        block_start = self.env.now
        # Pre-register this job's trace entry as "Waiting" BEFORE requesting
        # the machine. If the simulation ends while this job is still
        # suspended on `yield req` below, SimPy simply abandons the
        # coroutine — no code after the yield ever runs for it, so without
        # this the job would vanish from the trace entirely (a gap common to
        # other DES tools' entity logs too; see _format_job_id's docstring
        # context). The SAME dict is mutated in place once the job actually
        # proceeds, so a job that does get the machine ends up with just one
        # final "Completed"/"In Progress" entry, not a leftover "Waiting" one.
        if resource_name not in self.completion_log:
            self.completion_log[resource_name] = []
        trace_entry = {
            "job_id": _format_job_id(variant_type, variant_id),
            "station_name": resource_name,
            "status": "Waiting",
            "process_start_time_real": None,
            "process_end_time_real": None,
            "delay_reason": "Waiting in queue — station busy",
        }
        self.completion_log[resource_name].append(trace_entry)

        # Buffer Discipline controls which waiting job gets the machine next
        # when a slot frees up. FIFO (default) uses priority 0 for everyone —
        # ties break by arrival time, identical to plain Resource/today's
        # behaviour. LIFO uses a priority that decreases over time so the
        # most recently queued job outranks jobs that have been waiting longer.
        discipline = str(self.stations_data[resource_name].get("Buffer Discipline", "FIFO") or "FIFO").strip().upper()
        priority = -self.env.now if discipline == "LIFO" else 0
        with resource.request(priority=priority) as req:
            yield req
            # This job has just secured the machine slot — if it arrived here
            # via a rack buffer, release its physical rack slot NOW (not
            # earlier), so the rack genuinely holds the job occupying space
            # for as long as it's waiting for this machine, not just for the
            # instant it became front-of-lane.
            if on_machine_acquired is not None:
                on_machine_acquired()
            blocked_time = self.env.now - block_start
            total_blocked += blocked_time

            if not first_station:
                self.stations_data[resource_name]["total_block_time"] = (
                    self.stations_data[resource_name].get("total_block_time", 0) + blocked_time
                )
                self.stations_data[resource_name]["job_wait_count"] = (
                    self.stations_data[resource_name].get("job_wait_count", 0) + 1
                )
                self.stations_data[resource_name]["job_counts"]["waiting"] -= 1
                if self.stations_data[resource_name]["job_wait_count"] > 0:
                    self.stations_data[resource_name]["avg_block_time"] = (
                        self.stations_data[resource_name]["total_block_time"]
                        / self.stations_data[resource_name]["job_wait_count"]
                    )

            self._log_event(variant_name, resource_name, shifts_per_day, "blocked",
                            block_start, self.env.now, blocked_time=blocked_time,
                            start_date=start_date)

            # --- Setup / changeover ---
            # Charged only when this station's next job is a different variant
            # than the one it last processed (matches Simul8/FlexSim/Arena's
            # "changeover on type change" model) — same variant back-to-back
            # incurs zero setup time. Runs while still holding the resource,
            # shift-aware, before cycle time starts.
            last_variant = self.stations_data[resource_name].get("last_variant_type")
            setup_time = self._setup_time_for(resource_name, last_variant, variant_type)
            if setup_time > 0 and variant_type != last_variant:
                setup_time_remaining = setup_time
                su_start = self.env.now
                while setup_time_remaining > 0:
                    real_time = start_date + timedelta(minutes=self.env.now)
                    if SimulationUtils.is_active_shift(shift_cfg, real_time, shifts_per_day):
                        _, is_start = SimulationUtils.calculate_active_shift_time(
                            shift_cfg, real_time, shifts_per_day
                        )
                        used = 0 if is_start else (self.env.now % self.sim_config.get("ACTIVE_PROCESSING_TIME", 480))
                        avail = max(0.0, self.sim_config.get("ACTIVE_PROCESSING_TIME", 480) - used)
                        chunk = min(setup_time_remaining, avail) if avail > 0 else setup_time_remaining
                        # Cap at the next break so a break shorter than this
                        # chunk still actually pauses it — otherwise a single
                        # env.timeout() could run straight through a break
                        # with no intermediate is_active_shift check.
                        until_break = SimulationUtils.minutes_until_next_break(shift_cfg, real_time, shifts_per_day)
                        chunk = min(chunk, until_break)
                        yield self.env.timeout(chunk)
                        setup_time_remaining -= chunk
                        setup_time_remaining = max(0.0, setup_time_remaining)
                    else:
                        real_time = start_date + timedelta(minutes=self.env.now)
                        wait = SimulationUtils.wait_until_next_shift(shift_cfg, real_time, shifts_per_day)
                        if (wait + self.simulation_state["total_simulated_time"]) > self.sim_config["SIM_TIME"]:
                            break
                        yield self.env.timeout(wait)
                        total_pause += wait

                su_dur = self.env.now - su_start
                total_setup += su_dur
                self.stations_data[resource_name]["total_setup_time"] = (
                    self.stations_data[resource_name].get("total_setup_time", 0) + su_dur
                )
                self.stations_data[resource_name]["setup_events"] = (
                    self.stations_data[resource_name].get("setup_events", 0) + 1
                )
                self._log_event(variant_name, resource_name, shifts_per_day, "setup completed",
                                su_start, self.env.now, setup_time=su_dur, start_date=start_date)
            self.stations_data[resource_name]["last_variant_type"] = variant_type

            self.stations_data[resource_name]["job_counts"]["processing"] += 1
            cycle_time = adjusted_ct
            process_start = self.env.now
            processing_time = 0.0
            horizon_cutoff = False

            # --- Main processing loop (shift-aware) ---
            while cycle_time > 0:
                real_time = start_date + timedelta(minutes=self.env.now)

                if SimulationUtils.is_active_shift(shift_cfg, real_time, shifts_per_day):
                    active_elapsed, is_shift_start = SimulationUtils.calculate_active_shift_time(
                        shift_cfg, real_time, shifts_per_day
                    )
                    used = 0 if is_shift_start else active_elapsed % self.sim_config.get("ACTIVE_PROCESSING_TIME", 480)
                    available = max(0.0, self.sim_config.get("ACTIVE_PROCESSING_TIME", 480) - used)

                    while available > 0:
                        # Machine downtime
                        available, dt_added = yield from self._handle_machine_downtime(
                            resource, variant_name, resource_name, shifts_per_day, available, start_date
                        )
                        total_station_dt += dt_added
                        station_downtime_budget -= dt_added

                        # Operator availability
                        if self.operators_data and has_operators:
                            current_shift = SimulationUtils.get_active_shift(
                                self.env, self.simulation_state, shift_cfg, shifts_per_day
                            )
                            if current_shift is not None:
                                valid_ops = SimulationUtils.resolve_assigned_operators(
                                    self.stations_data, self.operators_data, resource_name, current_shift
                                )
                                if valid_ops:
                                    operator = SimulationUtils.operator_available(
                                        self.stations_data, self.operators_data, resource_name, current_shift
                                    )
                                    available, op_dt_added, cycle_time = yield from self._handle_operator(
                                        operator, resource_name, variant_name, shifts_per_day,
                                        available, cycle_time, start_date
                                    )
                                    total_operator_dt += op_dt_added

                        # Material shortage
                        shortage = SimulationUtils.check_material_shortage(self.stations_data, resource_name)
                        if shortage > 0:
                            ms_start = self.env.now
                            yield self.env.timeout(min(shortage, available))
                            ms_dur = self.env.now - ms_start
                            material_unavail += ms_dur
                            available -= ms_dur
                            available = max(0.0, available)

                        # Process chunk
                        if cycle_time <= 0:
                            break
                        chunk = min(cycle_time, available)
                        # Cap at the next break so a break shorter than this
                        # chunk still actually pauses processing — otherwise
                        # a single env.timeout() could run straight through a
                        # break with no intermediate is_active_shift check.
                        chunk_real_time = start_date + timedelta(minutes=self.env.now)
                        until_break = SimulationUtils.minutes_until_next_break(shift_cfg, chunk_real_time, shifts_per_day)
                        chunk = min(chunk, until_break)
                        if chunk <= 0:
                            break
                        yield self.env.timeout(chunk)
                        processing_time += chunk
                        available -= chunk
                        cycle_time -= chunk
                        available = max(0.0, available)
                        cycle_time = max(0.0, cycle_time)

                    remaining_dt = max(0.0, station_downtime_budget)
                    total_station_dt += remaining_dt
                    if remaining_dt > 0:
                        yield self.env.timeout(remaining_dt)

                else:
                    # Outside shift — wait for next shift
                    real_time = start_date + timedelta(minutes=self.env.now)
                    wait = SimulationUtils.wait_until_next_shift(shift_cfg, real_time, shifts_per_day)
                    if (wait + self.simulation_state["total_simulated_time"]) > self.sim_config["SIM_TIME"]:
                        horizon_cutoff = True
                        break
                    pause_start = self.env.now
                    yield self.env.timeout(wait)
                    total_pause += wait
                    self._log_event(variant_name, resource_name, shifts_per_day, "pause_time",
                                    pause_start, self.env.now, pause_time=wait, start_date=start_date)

            total_processing += processing_time

            # Job was cut short by the simulation horizon before finishing its
            # cycle time — do not count it as completed or bill its full
            # nominal duration; only the real partial processing_time happened.
            # Still record a completion_log entry (status "In Progress") so
            # the job trace doesn't silently drop it — a common gap in other
            # DES tools' entity logs (see _format_job_id's docstring context).
            if horizon_cutoff and cycle_time > 0:
                self.stations_data[resource_name]["job_counts"]["processing"] -= 1
                self.stations_data[resource_name]["busy_time"] = (
                    self.stations_data[resource_name].get("busy_time", 0) + processing_time
                )
                trace_entry.update({
                    "status": "In Progress",
                    "Processing Time": processing_time,
                    "process_start_time_real": (start_date + timedelta(minutes=process_start)).strftime("%Y-%m-%d %H:%M:%S"),
                    "process_end_time_real": None,
                    "delay_reason": _determine_delay_reason(
                        total_blocked, total_station_dt, total_operator_dt,
                        total_setup, material_unavail, total_rework,
                    ),
                })
                return

            # --- Rework ---
            current_shift = SimulationUtils.get_active_shift(
                self.env, self.simulation_state, shift_cfg, shifts_per_day
            )
            operator = SimulationUtils.operator_available(
                self.stations_data, self.operators_data, resource_name, current_shift
            )
            rework_time = SimulationUtils.check_rework(
                self.stations_data, resource_name, adjusted_ct, operator
            )
            if rework_time > 0:
                rw_start = self.env.now
                self.stations_data[resource_name]["rework_events"] = (
                    self.stations_data[resource_name].get("rework_events", 0) + 1
                )
                # Process rework respecting shifts
                while rework_time > 0:
                    real_time = start_date + timedelta(minutes=self.env.now)
                    if SimulationUtils.is_active_shift(shift_cfg, real_time, shifts_per_day):
                        _, is_start = SimulationUtils.calculate_active_shift_time(
                            shift_cfg, real_time, shifts_per_day
                        )
                        used = 0 if is_start else (self.env.now % self.sim_config.get("ACTIVE_PROCESSING_TIME", 480))
                        avail = max(0.0, self.sim_config.get("ACTIVE_PROCESSING_TIME", 480) - used)
                        chunk = min(rework_time, avail) if avail > 0 else rework_time
                        # Cap at the next break, same reasoning as the setup
                        # and main processing chunks above.
                        until_break = SimulationUtils.minutes_until_next_break(shift_cfg, real_time, shifts_per_day)
                        chunk = min(chunk, until_break)
                        yield self.env.timeout(chunk)
                        processing_time += chunk
                        rework_time -= chunk
                        rework_time = max(0.0, rework_time)
                    else:
                        real_time = start_date + timedelta(minutes=self.env.now)
                        wait = SimulationUtils.wait_until_next_shift(shift_cfg, real_time, shifts_per_day)
                        if (wait + self.simulation_state["total_simulated_time"]) > self.sim_config["SIM_TIME"]:
                            break
                        yield self.env.timeout(wait)
                        total_pause += wait

                rw_dur = self.env.now - rw_start
                total_rework += rw_dur
                self.stations_data[resource_name]["total_rework_time"] = (
                    self.stations_data[resource_name].get("total_rework_time", 0) + rw_dur
                )
                self._log_event(variant_name, resource_name, shifts_per_day, "rework completed",
                                rw_start, self.env.now, rework_time=rw_dur, start_date=start_date)

        # --- Completion ---
        process_end = self.env.now
        self.stations_data[resource_name]["job_counts"]["completed"] += 1
        self.stations_data[resource_name]["last_job_end_time"] = process_end
        # Stats below feed utilization/throughput KPIs directly. Jobs that
        # finish before WARMUP_TIME still flow through the line normally (so
        # downstream stations get realistically fed) but are excluded from
        # these counters, so KPIs reflect steady-state behaviour rather than
        # the empty-to-full ramp-up. See _validate_config for WARMUP_TIME.
        if process_end >= self.sim_config.get("WARMUP_TIME", 0):
            self.stations_data[resource_name]["busy_time"] = (
                self.stations_data[resource_name].get("busy_time", 0) + processing_time
            )
            # operator_busy_time = total person-minutes of labour actually performed.
            # processing_time is wall-clock time (already divided by num_operators),
            # so scale back up by num_operators rather than billing the nominal,
            # pre-division duration regardless of how much processing really happened.
            self.stations_data[resource_name]["operator_busy_time"] = (
                self.stations_data[resource_name].get("operator_busy_time", 0)
                + processing_time * num_operators
            )
            self.stations_data[resource_name]["completed_jobs_per_station"] = (
                self.stations_data[resource_name].get("completed_jobs_per_station", 0) + 1
            )
        self.stations_data[resource_name]["total_simulated_time_per_station"] += (process_end - process_start)

        self.simulation_state["current_jobs"][variant_name] = f"Completed at {resource_name}"
        self.simulation_state["running_jobs"].append(variant_name)
        self.simulation_state["job_exit_times"][variant_name] = process_end

        # Completion log
        total_shift_min = (
            len(SimulationUtils.active_shift_set(self.stations_data[resource_name]["shifts_per_day"]))
            * self.sim_config.get("SHIFT_DURATION", 480)
        )
        pcts = self._calc_pcts(
            total_processing, total_blocked, total_station_dt, total_pause,
            total_operator_dt, total_rework, material_unavail,
            self.stations_data[resource_name].get("total_waiting_time", 0),
            total_shift_min, total_setup,
        )
        trace_entry.update({
            "status": "Completed",
            "Completed_jobs": self.stations_data[resource_name].get("completed_jobs_per_station", 0),
            "Blocked Time": total_blocked,
            "Waiting Time": self.stations_data[resource_name].get("total_waiting_time", 0),
            "Processing Time": total_processing,
            "process_start_time_real": (start_date + timedelta(minutes=process_start)).strftime("%Y-%m-%d %H:%M:%S"),
            "process_end_time_real": (start_date + timedelta(minutes=process_end)).strftime("%Y-%m-%d %H:%M:%S"),
            "station_downtime": total_station_dt,
            "pause_time": total_pause,
            "operators_downtime": total_operator_dt,
            "total_rework_time": total_rework,
            "total_setup_time": total_setup,
            "material_unavailability": material_unavail,
            "delay_reason": _determine_delay_reason(
                total_blocked, total_station_dt, total_operator_dt,
                total_setup, material_unavail, total_rework,
            ),
            **pcts,
        })

        # Machine idle detection
        if resource.count == 0 and len(resource.queue) == 0:
            resource.wait_start_time = self.env.now

    # ------------------------------------------------------------------
    # Sub-operation helpers (keeps _perform_operation readable)
    # ------------------------------------------------------------------

    def _handle_machine_downtime(self, resource, variant_name, resource_name, shifts_per_day, available, start_date):
        """Wait out any machine downtime; return updated (available, downtime_added)."""
        dt_added = 0.0
        downtime_start = None
        while hasattr(resource, "working") and not resource.working:
            if downtime_start is None:
                downtime_start = self.env.now
            yield self.env.timeout(10)
        if downtime_start is not None:
            dt_end = self.env.now
            dt = dt_end - downtime_start
            dt_added += dt
            available -= dt
            self.stations_data[resource_name]["total_station_downtime"] = (
                self.stations_data[resource_name].get("total_station_downtime", 0) + dt
            )
            self._log_event(variant_name, resource_name, shifts_per_day, "station_downtime",
                            downtime_start, dt_end, station_downtime=dt, start_date=start_date)
        return max(0.0, available), dt_added

    def _handle_operator(self, operator, resource_name, variant_name, shifts_per_day,
                          available, cycle_time, start_date):
        """
        Wait for operator if unavailable; adjust cycle_time by skill.
        Returns (available, op_downtime_added, cycle_time).
        """
        op_dt_added = 0.0
        op_dt_start = None

        while not operator:
            if op_dt_start is None:
                op_dt_start = self.env.now
            yield self.env.timeout(10)
            current_shift = SimulationUtils.get_active_shift(
                self.env, self.simulation_state, self.sim_config, shifts_per_day
            )
            operator = SimulationUtils.operator_available(
                self.stations_data, self.operators_data, resource_name, current_shift
            )

        if op_dt_start is not None:
            op_dt_end = self.env.now
            op_dt = op_dt_end - op_dt_start
            op_dt_added += op_dt
            available -= op_dt
            self.stations_data[resource_name]["total_operator_downtime"] = (
                self.stations_data[resource_name].get("total_operator_downtime", 0) + op_dt
            )
            self.stations_data[resource_name]["operator_downtime_events"] = (
                self.stations_data[resource_name].get("operator_downtime_events", 0) + 1
            )
            self._log_event(variant_name, resource_name, shifts_per_day, "operator downtime",
                            op_dt_start, op_dt_end, operator_downtime=op_dt, start_date=start_date)

        # Adjust cycle_time by operator skill
        if operator:
            adjusted_times = [cycle_time * 1.0 for _, _ in operator]  # skill factor placeholder → 1.0
            cycle_time = sum(adjusted_times) / len(adjusted_times)

        return max(0.0, available), op_dt_added, cycle_time

    # ------------------------------------------------------------------
    # Post-processing
    # ------------------------------------------------------------------

    def _post_process(self):
        """Update utilizations and run bottleneck analysis."""
        self.progress_cb(0.9, "Calculating utilizations…")
        for name, station in self.stations_data.items():
            station["station_utilization"] = self._calc_station_util(station)
            station["operator_utilization"] = self._calc_operator_util(station)
            station["rework_percentage"] = self._calc_rework_pct(station)
            station["rework_time_ratio"] = self._calc_rework_time_ratio(station)
            station["setup_time_ratio"] = self._calc_setup_time_ratio(station)
            station["buffer_blocked_ratio"] = calc_buffer_blocked_ratio(station)

        self.progress_cb(0.95, "Analysing bottlenecks…")
        for name, station in self.stations_data.items():
            station["avg_block_time"] = calc_avg_block_time(station)

            self.bottleneck_store[name] = {
                "bottlenecks": identify_bottlenecks(
                    name, station, self.operators_data, self.sim_config, self.cycle_times
                ),
                "job_impact": calculate_affected_jobs(name, station, self.sim_config, self.cycle_times),
                "event_analysis": event_analyse(name, station, self.cycle_times),
            }

        self.progress_cb(1.0, "Done")

    # ------------------------------------------------------------------
    # Utilization calculations
    # ------------------------------------------------------------------

    def _calc_station_util(self, station: dict) -> float:
        return calc_station_utilization(station, self.sim_config)

    def _calc_operator_util(self, station: dict) -> float:
        return calc_operator_utilization(station, self.sim_config)

    def _calc_rework_pct(self, station: dict) -> float:
        return calc_rework_pct(station)

    def _calc_rework_time_ratio(self, station: dict) -> float:
        return calc_rework_time_ratio(station)

    def _calc_setup_time_ratio(self, station: dict) -> float:
        return calc_setup_time_ratio(station)

    # ------------------------------------------------------------------
    # Result collection
    # ------------------------------------------------------------------

    def _collect_results(self) -> Dict[str, Any]:
        sim_time = self.sim_config.get("SIM_TIME", 1) or 1
        station_stats = {
            name: {
                "station_utilization": s.get("station_utilization", 0),
                "operator_utilization": s.get("operator_utilization", 0),
                "rework_percentage": s.get("rework_percentage", 0),
                "rework_time_ratio": s.get("rework_time_ratio", 0),
                "setup_time_ratio": s.get("setup_time_ratio", 0),
                "total_setup_time": s.get("total_setup_time", 0),
                "buffer_blocked_ratio": s.get("buffer_blocked_ratio", 0),
                "buffer_blocked_time": s.get("buffer_blocked_time", 0),
                "buffer_capacity": s.get("Buffer Capacity", 0) or 0,
                "buffer_discipline": str(s.get("Buffer Discipline", "FIFO") or "FIFO").strip().upper(),
                "completed_jobs": s.get("completed_jobs_per_station", 0),
                "throughput": calc_station_throughput(s.get("completed_jobs_per_station", 0), sim_time),
                "busy_time": s.get("busy_time", 0),
                "total_waiting_time": s.get("total_waiting_time", 0),
                "avg_block_time": s.get("avg_block_time", 0),
                "failure_breakdowns": s.get("failure_breakdowns", 0),
                "pm_breakdowns": s.get("pm_breakdowns", 0),
                "operator_per_station": s.get("operator_per_station", 1),
                "capacity": s.get("capacity", 1),
            }
            for name, s in self.stations_data.items()
        }

        completed_jobs = self.simulation_state.get("completed_jobs", 0)
        self.simulation_state["summary"] = build_summary(completed_jobs, sim_time, station_stats)

        return {
            "simulation_state": self.simulation_state,
            "station_stats": station_stats,
            "job_log": self.job_log,
            "completion_log": self.completion_log,
            "bottleneck_store": self.bottleneck_store,
        }

    # ------------------------------------------------------------------
    # Statistical replication aggregation (from des_runner.py)
    # ------------------------------------------------------------------

    def _aggregate_replications(self, results: List[Dict]) -> Dict[str, Any]:
        """Average key metrics across replications; attach 95% CI."""
        if not results:
            return {}

        station_names = list(results[0]["station_stats"].keys())
        aggregated_stations = {}

        def _avg(key, default=0.0):
            return lambda samples: stats_lib.mean(samples) if samples else default

        for name in station_names:
            def _s(key):
                return [r["station_stats"][name].get(key, 0) for r in results]

            aggregated_stations[name] = {
                "station_utilization":    stats_lib.mean(_s("station_utilization")),
                "station_utilization_ci": _confidence_interval(_s("station_utilization")),
                "operator_utilization":   stats_lib.mean(_s("operator_utilization")),
                "operator_utilization_ci":_confidence_interval(_s("operator_utilization")),
                "rework_percentage":      stats_lib.mean(_s("rework_percentage")),
                "rework_time_ratio":      stats_lib.mean(_s("rework_time_ratio")),
                "setup_time_ratio":       stats_lib.mean(_s("setup_time_ratio")),
                "total_setup_time":       stats_lib.mean(_s("total_setup_time")),
                "buffer_blocked_ratio":   stats_lib.mean(_s("buffer_blocked_ratio")),
                "buffer_blocked_time":    stats_lib.mean(_s("buffer_blocked_time")),
                "buffer_capacity":        results[0]["station_stats"][name].get("buffer_capacity", 0),
                "buffer_discipline":      results[0]["station_stats"][name].get("buffer_discipline", "FIFO"),
                "completed_jobs":         round(stats_lib.mean(_s("completed_jobs"))),
                "completed_jobs_ci":      _confidence_interval(_s("completed_jobs")),
                "throughput":             round(stats_lib.mean(_s("throughput")), 4),
                "busy_time":              stats_lib.mean(_s("busy_time")),
                "avg_block_time":         stats_lib.mean(_s("avg_block_time")),
                "failure_breakdowns":     round(stats_lib.mean(_s("failure_breakdowns"))),
                "pm_breakdowns":          round(stats_lib.mean(_s("pm_breakdowns"))),
                "operator_per_station":   results[0]["station_stats"][name].get("operator_per_station", 1),
                "capacity":               results[0]["station_stats"][name].get("capacity", 1),
            }

        # Aggregate simulation_state (avg completed_jobs across reps, avg sim time)
        total_jobs = round(stats_lib.mean(
            [r.get("simulation_state", {}).get("completed_jobs", 0) for r in results]
        ))
        avg_in_progress = round(stats_lib.mean(
            [r.get("simulation_state", {}).get("in_progress_jobs", 0) for r in results]
        ))
        avg_sim_time = stats_lib.mean(
            [r.get("simulation_state", {}).get("total_simulated_time", 0) for r in results]
        )

        # Use completion_log from the last replication for Gantt
        last_log = results[-1].get("completion_log", {})

        # Aggregate bottleneck_store across replications so multi-rep runs keep
        # their bottleneck info (previously dropped → empty top_bottleneck rows).
        # Per station: pick the most common top-bottleneck *type* across reps and
        # a representative full entry of that type.
        from collections import Counter
        aggregated_bottlenecks: Dict[str, Any] = {}
        for name in station_names:
            top_entries = [
                (r.get("bottleneck_store", {}).get(name, {}).get("bottlenecks") or [None])[0]
                for r in results
            ]
            top_entries = [e for e in top_entries if e]
            if not top_entries:
                continue
            common_type = Counter(e.get("type") for e in top_entries).most_common(1)[0][0]
            representative = next(
                (e for e in top_entries if e.get("type") == common_type), top_entries[0]
            )
            aggregated_bottlenecks[name] = {"bottlenecks": [representative]}

        sim_time = avg_sim_time or 1
        agg_summary = build_summary(total_jobs, sim_time, aggregated_stations)

        return {
            "num_replications": len(results),
            "station_stats": aggregated_stations,
            "simulation_state": {
                "completed_jobs": total_jobs,
                "in_progress_jobs": avg_in_progress,
                "total_simulated_time": avg_sim_time,
                "summary": agg_summary,
            },
            "completion_log": last_log,
            "bottleneck_store": aggregated_bottlenecks,
            "raw_replications": results,
        }

    # ------------------------------------------------------------------
    # Logging helper
    # ------------------------------------------------------------------

    def _log_event(
        self,
        variant_name: str,
        station: str,
        shifts_per_day: Any,
        event: str,
        start: float,
        end: float,
        start_date: Optional[datetime] = None,
        **kwargs,
    ):
        if start_date is None:
            start_date = self.simulation_state.get("start_date", datetime(2025, 1, 1))
        entry = {
            "station": station,
            "shifts_per_day": shifts_per_day,
            "event": event,
            "start_time": start,
            "end_time": end,
            "start_date_real": (start_date + timedelta(minutes=start)).strftime("%Y-%m-%d"),
            "start_time_real": (start_date + timedelta(minutes=start)).strftime("%H:%M:%S"),
            "end_date_real": (start_date + timedelta(minutes=end)).strftime("%Y-%m-%d"),
            "end_time_real": (start_date + timedelta(minutes=end)).strftime("%H:%M:%S"),
            **kwargs,
        }
        self.job_log.setdefault(variant_name, []).append(entry)

    @staticmethod
    def _calc_pcts(processing, blocked, station_dt, pause, op_dt, rework, mat_unavail, waiting, total_shift_min, setup=0.0):
        return calc_time_percentages(processing, blocked, station_dt, pause, op_dt, rework, mat_unavail, waiting, total_shift_min, setup)


# ---------------------------------------------------------------------------
# Statistics helper
# ---------------------------------------------------------------------------

def _confidence_interval(samples: List[float], confidence: float = 0.95) -> Dict:
    """95% t-distribution CI from des_runner.py."""
    n = len(samples)
    if n < 2:
        mean = samples[0] if samples else 0.0
        return {"mean": mean, "ci_lower": mean, "ci_upper": mean, "std": 0.0, "n": n}

    mean = stats_lib.mean(samples)
    std = stats_lib.stdev(samples)

    try:
        from scipy import stats as scipy_stats
        t_val = scipy_stats.t.ppf((1 + confidence) / 2, df=n - 1)
    except ImportError:
        t_val = 2.0  # Rough 95% fallback

    margin = t_val * std / (n ** 0.5)
    return {
        "mean": round(mean, 4),
        "ci_lower": round(mean - margin, 4),
        "ci_upper": round(mean + margin, 4),
        "std": round(std, 4),
        "n": n,
    }
