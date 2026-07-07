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
    calc_rework_pct, calc_rework_time_ratio, calc_avg_block_time, calc_time_percentages,
)
from .sim_utils import SimulationUtils
from .bottleneck import identify_bottlenecks, calculate_affected_jobs, event_analyse

logger = logging.getLogger("linksim.engine")

# Safety guardrail: the longest simulated horizon we allow in a single run.
# 525600 minutes = 1 year (also the frontend's max). Requests above this are
# clamped (with a warning) so a runaway value can't make a run effectively
# never terminate.
MAX_SIM_TIME = 525_600.0


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
    progress_callback   : optional callable(pct: float, msg: str)

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
        progress_callback: Optional[Callable[[float, str], None]] = None,
    ):
        self.stations_data = {k: dict(v) for k, v in stations_data.items()}
        self.processflow_data = processflow_data
        self.variant_quantities = variant_quantities
        self.operators_data = operators_data
        self.sim_config = simulation_config
        self.progress_cb = progress_callback or (lambda pct, msg: None)

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
        self._post_process()
        return self._collect_results()

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

    def _reset_state(self):
        self.env = simpy.Environment()
        self.job_log = {}
        self.completion_log = {}
        self.bottleneck_store = {}
        self.simulation_state = {
            "start_date": datetime(2025, 1, 1, 6, 0, 0),
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

    def _resolve_resource(self, raw_name: str) -> Optional[str]:
        """Return the canonical station key for raw_name, or None if not found."""
        if raw_name in self.stations_data:
            return raw_name
        normalized = raw_name.lower().strip()
        return self._resource_key_map.get(normalized)

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

    def _run_simpy(self):
        total_jobs = sum(self.variant_quantities.values())
        spawned = 0

        for variant, qty in self.variant_quantities.items():
            for i in range(1, qty + 1):
                self.env.process(self._process_variant(i, variant))
                spawned += 1
                self.progress_cb(spawned / total_jobs * 0.5, f"Scheduling {variant} #{i}")

        self.simulation_state["in_progress_jobs"] = total_jobs
        self.progress_cb(0.5, "Running simulation…")
        self.env.run(until=self.sim_config["SIM_TIME"])

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

    def _process_variant(self, variant_id: int, variant_type: str):
        steps = self.processflow_data.get(variant_type, [])
        for step in steps:
            raw_name = step["resource"]
            resource_name = self._resolve_resource(raw_name)
            if resource_name is None:
                logger.warning(
                    "Resource '%s' not found in stations_data — skipping step '%s' for %s#%s",
                    raw_name, step.get("operation"), variant_type, variant_id,
                )
                continue
            durations = step.get("durations")
            try:
                if isinstance(durations, list):
                    for duration in durations:
                        yield from self._perform_operation(
                            resource_name, variant_id, variant_type,
                            step["operation"],
                            self.stations_data[resource_name].get("operator_per_station", 1),
                            self.stations_data[resource_name].get("shifts_per_day", 1),
                            duration,
                        )
                else:
                    yield from self._perform_operation(
                        resource_name, variant_id, variant_type,
                        step["operation"],
                        self.stations_data[resource_name].get("operator_per_station", 1),
                        self.stations_data[resource_name].get("shifts_per_day", 1),
                        step["duration"],
                    )
            except Exception as exc:
                logger.error(
                    "%s#%s at station '%s' op '%s': %s",
                    variant_type, variant_id, resource_name, step.get("operation"), exc,
                    exc_info=True,
                )
                # Continue to next step so job can still complete

        self.simulation_state["total_simulated_time"] = self.env.now
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
        shifts_per_day: int,
        duration: float,
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
        material_unavail = 0.0
        station_downtime_budget = self.sim_config.get("STATION_DOWNTIME", 0)

        block_start = self.env.now
        with resource.request() as req:
            yield req
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

            self.stations_data[resource_name]["job_counts"]["processing"] += 1
            cycle_time = adjusted_ct
            process_start = self.env.now
            processing_time = 0.0

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
                        break
                    pause_start = self.env.now
                    yield self.env.timeout(wait)
                    total_pause += wait
                    self._log_event(variant_name, resource_name, shifts_per_day, "pause_time",
                                    pause_start, self.env.now, pause_time=wait, start_date=start_date)

            total_processing += processing_time

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
        self.stations_data[resource_name]["busy_time"] = (
            self.stations_data[resource_name].get("busy_time", 0) + processing_time
        )
        # operator_busy_time uses original duration (not divided by num_operators)
        # so operator utilization matches industry standard: actual work time / shift time
        self.stations_data[resource_name]["operator_busy_time"] = (
            self.stations_data[resource_name].get("operator_busy_time", 0) + duration
        )
        self.stations_data[resource_name]["total_simulated_time_per_station"] += (process_end - process_start)
        self.stations_data[resource_name]["completed_jobs_per_station"] = (
            self.stations_data[resource_name].get("completed_jobs_per_station", 0) + 1
        )

        self.simulation_state["current_jobs"][variant_name] = f"Completed at {resource_name}"
        self.simulation_state["running_jobs"].append(variant_name)
        self.simulation_state["job_exit_times"][variant_name] = process_end

        # Completion log
        total_shift_min = (
            self.stations_data[resource_name]["shifts_per_day"]
            * self.sim_config.get("SHIFT_DURATION", 480)
        )
        pcts = self._calc_pcts(
            total_processing, total_blocked, total_station_dt, total_pause,
            total_operator_dt, total_rework, material_unavail,
            self.stations_data[resource_name].get("total_waiting_time", 0),
            total_shift_min,
        )
        if resource_name not in self.completion_log:
            self.completion_log[resource_name] = []
        self.completion_log[resource_name].append({
            "station_name": resource_name,
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
            "material_unavailability": material_unavail,
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
                "completed_jobs": s.get("completed_jobs_per_station", 0),
                "throughput": calc_station_throughput(s.get("completed_jobs_per_station", 0), sim_time),
                "busy_time": s.get("busy_time", 0),
                "total_waiting_time": s.get("total_waiting_time", 0),
                "avg_block_time": s.get("avg_block_time", 0),
                "failure_breakdowns": s.get("failure_breakdowns", 0),
                "pm_breakdowns": s.get("pm_breakdowns", 0),
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
                "completed_jobs":         round(stats_lib.mean(_s("completed_jobs"))),
                "completed_jobs_ci":      _confidence_interval(_s("completed_jobs")),
                "throughput":             round(stats_lib.mean(_s("throughput")), 4),
                "busy_time":              stats_lib.mean(_s("busy_time")),
                "avg_block_time":         stats_lib.mean(_s("avg_block_time")),
                "failure_breakdowns":     round(stats_lib.mean(_s("failure_breakdowns"))),
                "pm_breakdowns":          round(stats_lib.mean(_s("pm_breakdowns"))),
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
        shifts_per_day: int,
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
    def _calc_pcts(processing, blocked, station_dt, pause, op_dt, rework, mat_unavail, waiting, total_shift_min):
        return calc_time_percentages(processing, blocked, station_dt, pause, op_dt, rework, mat_unavail, waiting, total_shift_min)


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
