"""
Machine resource model — adapted from UpdatedSimulationProject/models/Machine_data.py.
Decoupled from Dash/Streamlit. Pure SimPy.
"""
import simpy
import random
import numpy as np
from typing import Optional
from .formulas import daily_failure_rate_to_per_minute, PM_INTERVALS


class Machine(simpy.PriorityResource):
    """
    SimPy resource representing a physical machine with failure and PM support.
    Extracted from existing projects; print statements replaced with structured logs.

    Subclasses PriorityResource (not plain Resource) so a station's waiting
    queue can be served FIFO (default — every request uses priority 0, tied
    requests are served in arrival order, identical to plain Resource) or
    LIFO (requests use a priority that decreases with arrival time, so the
    most recently queued job is served next) — see Buffer Discipline in
    sim_core.py's _perform_operation.
    """

    def __init__(
        self,
        env: simpy.Environment,
        name: str,
        failure_rate: float,
        repair_time: float,
        pm_schedule: Optional[str],
        capacity: int,
        job_log: dict,
        simulation_time: Optional[float] = None,
    ):
        super().__init__(env, capacity=capacity)
        if not (0 <= failure_rate <= 1):
            raise ValueError("failure_rate must be between 0 and 1")
        if repair_time <= 0:
            raise ValueError("repair_time must be positive")

        self.env = env
        self.name = name
        self.failure_rate = failure_rate
        self.repair_time = repair_time
        self.pm_schedule = pm_schedule
        self.pm_time = repair_time
        self.job_log = job_log
        self.simulation_time = simulation_time

        self.working = True
        self.failure_count = 0
        self.pm_count = 0
        self.downtime_log: list = []
        self.total_downtime: float = 0.0
        self.last_event_type: Optional[str] = None
        self.wait_start_time: Optional[float] = None

        # Mutex prevents simultaneous failure + PM
        self.mutex = simpy.Resource(env, capacity=1)
        self.working_event = env.event()
        self.working_event.succeed()

        if simulation_time is not None:
            self.failure_process = env.process(self._run_failure_cycle())
            self.pm_process = env.process(self._run_preventive_maintenance())

    # ------------------------------------------------------------------
    # Internal SimPy processes
    # ------------------------------------------------------------------

    def _run_failure_cycle(self):
        """Stochastic failure process. Runs for the full simulation duration."""
        while self.env.now < self.simulation_time:
            try:
                # If the machine is currently down (e.g. PM in progress), wait
                # in real (timed) steps for it to come back up.
                while not self.working:
                    yield self.env.timeout(1)

                lambda_per_minute = daily_failure_rate_to_per_minute(self.failure_rate)
                failure_time = max(0, random.expovariate(lambda_per_minute))

                yield self.env.timeout(failure_time)

                with self.mutex.request() as req:
                    yield req
                    failure_start = self.env.now
                    self.working = False
                    self.last_event_type = "failure"
                    self.working_event = self.env.event()

                    yield self.env.timeout(self.repair_time)

                    failure_end = self.env.now
                    downtime = failure_end - failure_start
                    self.downtime_log.append(("Failure", failure_start, failure_end, downtime))
                    self.total_downtime += downtime
                    self.failure_count += 1
                    self.working = True
                    self.working_event.succeed()
                    self.working_event = self.env.event()

            except simpy.Interrupt:
                self.working = True
                break
            except Exception:
                yield self.env.timeout(60)

    def _run_preventive_maintenance(self):
        """Scheduled PM process — Monthly or Weekly."""
        pm_interval = PM_INTERVALS.get(self.pm_schedule, float("inf"))

        while self.env.now < self.simulation_time:
            try:
                if pm_interval == float("inf"):
                    yield self.env.timeout(self.simulation_time - self.env.now)
                    break

                yield self.env.timeout(pm_interval)

                with self.mutex.request() as req:
                    yield req
                    pm_start = self.env.now
                    self.working = False
                    self.last_event_type = "maintenance"
                    self.working_event = self.env.event()

                    yield self.env.timeout(self.pm_time)

                    pm_end = self.env.now
                    downtime = pm_end - pm_start
                    self.downtime_log.append(("Maintenance", pm_start, pm_end, downtime))
                    self.total_downtime += downtime
                    self.pm_count += 1
                    self.working = True
                    self.working_event.succeed()
                    self.working_event = self.env.event()

            except simpy.Interrupt:
                self.working = True
                break

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def get_downtime_report(self) -> dict:
        """Return structured downtime report (replaces print_downtime_report)."""
        failure_events = [(s, e, d) for t, s, e, d in self.downtime_log if t == "Failure"]
        pm_events = [(s, e, d) for t, s, e, d in self.downtime_log if t == "Maintenance"]
        return {
            "machine": self.name,
            "total_downtime_min": round(self.total_downtime, 2),
            "failure_count": len(failure_events),
            "failure_total_min": round(sum(d for _, _, d in failure_events), 2),
            "pm_count": len(pm_events),
            "pm_total_min": round(sum(d for _, _, d in pm_events), 2),
            "events": [
                {"type": t, "start": s, "end": e, "duration": d}
                for t, s, e, d in self.downtime_log
            ],
        }
