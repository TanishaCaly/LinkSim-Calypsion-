"""
Machine resource model — adapted from UpdatedSimulationProject/models/Machine_data.py.
Decoupled from Dash/Streamlit. Pure SimPy.
"""
import simpy
import random
import numpy as np
from enum import Enum
from typing import Optional
from .formulas import (
    failure_rate_to_availability_pct,
    calculate_mtbf,
    PM_INTERVALS,
)

# Fixed seed for Exit Controller "Random" machine choice (see MachineGroup).
ROUTING_SEED = 42


class FailurePolicy(Enum):
    """Per Availability_MTTR_Details.pdf section 7/8 — what happens to a
    part's remaining processing time when its machine fails mid-operation."""
    RESUME = "resume"
    RESTART = "restart"
    SCRAP = "scrap"


class SubMachine(simpy.PriorityResource):
    """
    SimPy resource representing ONE physical machine with failure and PM
    support. Always a single-slot resource (capacity=1) — a station with
    multiple parallel machines is modeled as several independent SubMachines
    behind a MachineGroup (below), not as one SubMachine with capacity>1,
    so that a failure on one unit never affects the others.

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
        job_log: dict,
        simulation_time: Optional[float] = None,
        capacity: int = 1,
        failure_policy: "FailurePolicy" = FailurePolicy.RESUME,
        mtbf: Optional[float] = None,
    ):
        super().__init__(env, capacity=capacity)
        if not (0 <= failure_rate <= 1):
            raise ValueError("failure_rate must be between 0 and 1")
        if repair_time < 0:
            raise ValueError("repair_time must not be negative")
        if mtbf is not None and mtbf < 0:
            raise ValueError("mtbf must not be negative")

        self.env = env
        self.name = name
        self.failure_rate = failure_rate
        self.repair_time = repair_time
        self.pm_schedule = pm_schedule
        self.pm_time = repair_time
        self.job_log = job_log
        self.simulation_time = simulation_time
        self.failure_policy = failure_policy

        # Availability % / MTBF — per Availability_MTTR_Details.pdf sections
        # 1 and 4: Availability = MTBF / (MTBF + MTTR).
        #
        # `mtbf` (minutes, uncapped) is the PRIMARY input when given — it's
        # what the Process Flow tab's Availability%+MTTR fields write
        # (ScenarioManager.tsx's availabilityPctToFailureRate was replaced by
        # a direct MTBF write, since the old "Failure rate" 0-1 daily-
        # probability field can only express MTBF >= 1440 min (rate capped
        # at 1), which silently broke the PDF's own worked examples, e.g.
        # 90% Availability + 2 min MTTR needs MTBF=18 min, 80x below that
        # floor). `failure_rate` is kept only for legacy scenarios that
        # predate the MTBF field, and for bottleneck.py/ai_insights.py's
        # unrelated use of it as a raw 0-1 risk-scoring input (not a timing
        # value) — see those files' own failure_rate reads.
        if mtbf is not None:
            self.mtbf = mtbf
            self.availability = (
                100.0 if mtbf == float("inf")
                else (mtbf / (mtbf + repair_time) * 100.0 if (mtbf + repair_time) > 0 else 100.0)
            )
        else:
            self.availability = failure_rate_to_availability_pct(failure_rate, repair_time)
            self.mtbf = calculate_mtbf(self.availability, repair_time)

        self.working = True
        # Set by a parallel MachineGroup so it can hand a waiting job to this
        # machine the moment it comes back from failure/PM.
        self.on_available = None
        # Set by MachineGroup: called whenever a waiting request is granted,
        # i.e. the station's queue just got shorter (see _do_put).
        self.on_granted = None
        # Set by MachineGroup: called whenever this machine may have become
        # free — a job left it (_do_get) or it came back from failure/PM.
        self.on_freed = None
        self.failure_count = 0
        self.pm_count = 0
        self.downtime_log: list = []
        self.total_downtime: float = 0.0
        self.last_event_type: Optional[str] = None
        self.wait_start_time: Optional[float] = None

        # --- PDF section 7/9: in-flight work tracking for FailurePolicy ---
        # The job currently holding this machine (if any) registers its
        # process_time via begin_processing() (and clears it via
        # end_processing() on release) so fail() can compute
        # remaining_process_time exactly as the PDF's Station.fail() does,
        # and repair() can apply RESUME/RESTART/SCRAP to it.
        self.current_process_start: Optional[float] = None
        self.remaining_process_time: float = 0.0
        self._process_time_for_restart: float = 0.0
        self.failure_start_time: Optional[float] = None
        self.last_failure_outcome: Optional[str] = None  # "resume" | "restart" | "scrap"

        # The job's own SimPy process currently holding this machine, while
        # it's genuinely asleep inside a processing chunk (NOT the whole
        # time it holds the machine — see begin_chunk_sleep()/end_chunk_sleep()
        # below). A failure that starts while this is set actively interrupts
        # that sleep via simpy.Process.interrupt(), instead of only flipping
        # `working` and leaving a possibly-long env.timeout() asleep and
        # unaware a failure started and ended entirely during its nap —
        # see sim_core.py's chunk loop for the corresponding try/except.
        self._sleeping_job_process: Optional[simpy.Process] = None

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
        """Stochastic failure process. Runs for the full simulation duration.

        Per Availability_MTTR_Details.pdf sections 2/5/9:
          - time to next failure ~ Exp(1/MTBF)   (MTBF from Availability+MTTR)
          - repair duration       ~ Exp(1/MTTR)
        Neither is a fixed/deterministic interval, so failures across
        machines are never artificially synchronized (section 2's warning).
        """
        while self.env.now < self.simulation_time:
            try:
                # If the machine is currently down (e.g. PM in progress), wait
                # in real (timed) steps for it to come back up.
                while not self.working:
                    yield self.env.timeout(1)

                # PDF generate_time_to_failure(): expovariate(1/MTBF), or an
                # infinite wait if MTBF is infinite (Availability == 100).
                # Note: the PDF's own get_time_to_failure() only guards the
                # mtbf==inf case, not mtbf==0 (Availability<=0) — faithfully
                # reproduced here too. An mtbf==0 station would raise
                # ZeroDivisionError on the next line, caught by this
                # process's own except Exception below (60-min retry), not
                # a crash — but also not a true "always failed" station.
                # Not reachable from any valid (0<=failure_rate<=1, mttr>=0)
                # input today (availability only approaches but never
                # equals exactly 0), so left as the PDF specifies it.
                if self.mtbf == float("inf"):
                    yield self.env.timeout(self.simulation_time - self.env.now)
                    continue
                failure_time = max(0, random.expovariate(1.0 / self.mtbf))

                yield self.env.timeout(failure_time)

                with self.mutex.request() as req:
                    yield req
                    failure_start = self.env.now
                    self.failure_start_time = failure_start

                    # --- PDF section 7/9 fail(): capture remaining work on
                    # whatever job is currently in process on this machine,
                    # so repair() can apply RESUME/RESTART/SCRAP below.
                    if self.current_process_start is not None:
                        elapsed = failure_start - self.current_process_start
                        self.remaining_process_time = max(
                            0.0, self.remaining_process_time - elapsed
                        )

                    self.working = False
                    self.last_event_type = "failure"
                    self.working_event = self.env.event()

                    # Wake the job's chunk sleep RIGHT NOW, at the real
                    # failure instant, instead of leaving it asleep until
                    # its originally-scheduled chunk end — see
                    # begin_chunk_sleep's docstring. A job that is between
                    # chunks (setup, operator-wait, etc.) has this unset and
                    # is correctly left alone; sim_core.py's chunk loop
                    # already polls _handle_machine_downtime before each
                    # new chunk regardless.
                    if self._sleeping_job_process is not None and self._sleeping_job_process.is_alive:
                        self._sleeping_job_process.interrupt("machine_failed")

                    # PDF generate_repair_time(): expovariate(1/MTTR).
                    repair_time = (
                        random.expovariate(1.0 / self.repair_time)
                        if self.repair_time > 0 else 0.0
                    )
                    yield self.env.timeout(repair_time)

                    failure_end = self.env.now
                    downtime = failure_end - failure_start
                    self.downtime_log.append(("Failure", failure_start, failure_end, downtime))
                    self.total_downtime += downtime
                    self.failure_count += 1
                    self.failure_start_time = None

                    # --- PDF section 7/9 repair(): apply this machine's
                    # FailurePolicy to the in-flight job, if any.
                    if self.current_process_start is not None:
                        if self.failure_policy == FailurePolicy.RESTART:
                            self.remaining_process_time = self._process_time_for_restart
                        elif self.failure_policy == FailurePolicy.SCRAP:
                            self.remaining_process_time = 0.0
                        # RESUME: remaining_process_time already holds the
                        # correct leftover value from fail() above — no
                        # change needed.
                        self.last_failure_outcome = self.failure_policy.value
                        self.current_process_start = self.env.now

                    self.working = True
                    self.working_event.succeed()
                    self.working_event = self.env.event()
                    self._notify_available()

            except simpy.Interrupt:
                self._mark_working()
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
                    self._notify_available()

            except simpy.Interrupt:
                self._mark_working()
                break

    def _mark_working(self) -> None:
        # Jobs in sim_core.py's _handle_machine_downtime block on
        # working_event, so every path that brings the machine back up must
        # fire it — otherwise a waiting job would hang forever.
        self.working = True
        if not self.working_event.triggered:
            self.working_event.succeed()
        self._notify_available()

    def _notify_available(self) -> None:
        if self.on_available is not None:
            self.on_available()
        if self.on_freed is not None:
            self.on_freed()

    def _do_put(self, event):
        # SimPy grants a request here. Tell the group, so a job waiting for
        # room in this station's queue (Buffer Capacity >= 1) re-checks at
        # once instead of polling.
        result = super()._do_put(event)
        if event.triggered and self.on_granted is not None:
            self.on_granted()
        return result

    def _do_get(self, event):
        # SimPy releases a job's slot here. Tell the group, so a job waiting
        # for a free machine (an Exit Controller branch) re-checks at once.
        result = super()._do_get(event)
        if self.on_freed is not None:
            self.on_freed()
        return result

    # ------------------------------------------------------------------
    # In-flight job registration — PDF section 7/9: lets _run_failure_cycle's
    # fail()/repair() equivalent compute "4 min done, 6 min remaining" for
    # whichever job currently holds this machine, and apply RESUME/RESTART/
    # SCRAP to it.
    # ------------------------------------------------------------------

    def begin_processing(self, process_time: float) -> None:
        """Call when a job starts occupying this machine for `process_time`
        minutes of work (PDF's Process Time)."""
        self.current_process_start = self.env.now
        self.remaining_process_time = process_time
        self._process_time_for_restart = process_time
        self.last_failure_outcome = None

    def end_processing(self) -> None:
        """Call when the job releases this machine (completed or left)."""
        self.current_process_start = None
        self.remaining_process_time = 0.0
        self._sleeping_job_process = None

    def begin_chunk_sleep(self, job_process: "simpy.Process") -> None:
        """Call immediately before `yield self.env.timeout(chunk)` in the
        job's processing loop — arms this machine to interrupt `job_process`
        the instant a failure starts, instead of leaving it asleep for the
        full chunk duration unaware a failure started AND ended inside that
        single sleep. Only armed for the duration of the sleep itself (see
        end_chunk_sleep), not the job's whole stay on this machine — a
        failure during setup/operator-wait/etc. must not interrupt those,
        since only the chunk loop's try/except simpy.Interrupt is set up to
        catch it and recompute partial progress correctly."""
        self._sleeping_job_process = job_process

    def end_chunk_sleep(self) -> None:
        """Call right after the chunk's timeout resolves (normally OR via
        the interrupt it triggered) — disarms interruption until the next
        chunk explicitly re-arms it."""
        self._sleeping_job_process = None

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


class MachineGroup:
    """
    Coordinates `capacity` independent SubMachines for one station, so
    failure/repair/PM is tracked per physical machine instead of one shared
    flag for the whole pool (the latter let a failure on a multi-machine
    station go completely unnoticed by every job — see the MTTR capacity>1
    bug this class fixes).

    A job calls MachineGroup.request(priority), which hands it a SubMachine
    in cyclic order (see _dispatch) — that SubMachine is then the job's
    identity for the rest of its stay (downtime checks, etc.), so a
    failure on one SubMachine can never block a job running on another.

    simulation_time=None means no failure/PM modelling at all. Conveyors/
    passthroughs also pass pooled=True: they carry many jobs at once (a
    conveyor's Conveyor Capacity) with no machine identity, so a single
    lightweight SubMachine sized at the full capacity is used instead. A real
    station with failures switched off is NOT pooled — it still has
    `capacity` separate machines (just never failing), so the Exit
    Controller's cyclic/random/successor choice still applies to it.
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
        failure_policy: "FailurePolicy" = FailurePolicy.RESUME,
        mtbf: Optional[float] = None,
        pooled: Optional[bool] = None,
    ):
        self.env = env
        self.name = name
        self.wait_start_time: Optional[float] = None

        # Not given: pool exactly when there's no failure modelling (the
        # behaviour before `pooled` existed).
        if pooled is None:
            pooled = simulation_time is None
        if pooled:
            # Conveyor/passthrough — one pool sized at the full capacity.
            self.sub_machines = [
                SubMachine(
                    env=env, name=name, failure_rate=failure_rate, repair_time=repair_time,
                    pm_schedule=pm_schedule, job_log=job_log, simulation_time=None,
                    capacity=capacity, failure_policy=failure_policy, mtbf=mtbf,
                )
            ]
        else:
            self.sub_machines = [
                SubMachine(
                    env=env, name=f"{name}#{i}", failure_rate=failure_rate, repair_time=repair_time,
                    pm_schedule=pm_schedule, job_log=job_log, simulation_time=simulation_time,
                    capacity=1, failure_policy=failure_policy, mtbf=mtbf,
                )
                for i in range(max(1, capacity))
            ]

        # --- Cyclic dispatch (parallel machines only) ---
        # Jobs are handed to machines in turn (#1, #2, #3, #1, ...). A machine
        # whose turn it is but is busy (holding a job — processing or setup —
        # or down for failure/PM) is skipped, and the turn carries on after
        # whichever machine got the job. With every machine busy, jobs wait
        # here at the group, not on one machine, and the first machine to
        # free up takes the next one.
        #
        # Random (strategy="random", set from the previous station's Exit
        # Controller): same busy/wait rules, but the job goes to a randomly
        # chosen free machine — equal chance each, no turn order. Uses its
        # own fixed-seed generator so the choices repeat run to run and
        # don't shift the failure/repair random sequence.
        #
        # Successor (strategy="successor"): same busy/wait rules, but every
        # job tries the machines in the user's priority order — the best-
        # priority free machine always gets it. `priority_order` lists
        # sub_machines indexes, best first.
        self.strategy = "cyclic"
        self._rng = random.Random(ROUTING_SEED)
        self.priority_order: list = list(range(len(self.sub_machines)))
        self._next_turn = 0
        self._waiting: list = []  # pending _CyclicRequest, in arrival order
        self._seq = 0
        self._dispatch_pending = False
        if len(self.sub_machines) > 1:
            for sm in self.sub_machines:
                sm.on_available = self._schedule_dispatch
        # Fires each time a job leaves this station's queue (its request is
        # granted, or it gives up) — see queue_changed().
        self._queue_changed = env.event()
        # Fires each time one of this station's machines may have become
        # free — see freed().
        self._freed = env.event()
        for sm in self.sub_machines:
            sm.on_granted = self._notify_queue_changed
            sm.on_freed = self._notify_freed

    # ------------------------------------------------------------------
    # Acquisition
    # ------------------------------------------------------------------

    def request(self, priority: int = 0):
        """
        Returns a context manager: `with group.request(priority) as (req, sub):`
        acquires a slot on one SubMachine. The SubMachine it got is on the
        context manager's `sub_machine` once `req` has fired — for a parallel
        (cyclic) group the machine isn't chosen until then, so `sub` is None.
        """
        if len(self.sub_machines) == 1:
            return _GroupRequest(self.sub_machines[0], priority)
        self._seq += 1
        return _CyclicRequest(self, priority, self._seq)

    def request_machine(self, index: int, priority: int = 0) -> "_PinnedRequest":
        """
        Like request(), but for one chosen machine (sub_machines[index]) —
        used when an Exit Controller branch has already picked it. Same
        context-manager shape: `with ... as (req, sub):`.
        """
        return _PinnedRequest(self, self.sub_machines[index], priority)

    def machine_is_free(self, index: int) -> bool:
        """sub_machines[index] can take a job right now: up (not failed / in
        PM), not full, and nobody already waiting for it or for this
        station."""
        sm = self.sub_machines[index]
        return sm.working and sm.count < sm.capacity and not sm.queue and not self._waiting

    def freed(self) -> simpy.Event:
        """Fires the next time one of this station's machines may have become
        free (a job left it, or it came back from failure/PM)."""
        return self._freed

    def _notify_freed(self) -> None:
        event, self._freed = self._freed, self.env.event()
        event.succeed()

    @staticmethod
    def _is_free(sm: "SubMachine") -> bool:
        return sm.working and sm.count == 0 and len(sm.queue) == 0

    def _dispatch(self) -> None:
        self._dispatch_pending = False
        n = len(self.sub_machines)
        while self._waiting:
            if self.strategy == "random":
                free = [i for i in range(n) if self._is_free(self.sub_machines[i])]
                idx = self._rng.choice(free) if free else None
            elif self.strategy == "successor":
                idx = next((i for i in self.priority_order if self._is_free(self.sub_machines[i])), None)
            else:
                idx = next(
                    ((self._next_turn + k) % n for k in range(n)
                     if self._is_free(self.sub_machines[(self._next_turn + k) % n])),
                    None,
                )
            if idx is None:
                return
            # Same ordering PriorityResource used: lower priority first,
            # ties by arrival (FIFO; LIFO passes a decreasing priority).
            pending = min(self._waiting, key=lambda r: (r.priority, r.seq))
            self._waiting.remove(pending)
            self._next_turn = (idx + 1) % n
            pending._grant(self.sub_machines[idx])

    def queue_changed(self) -> simpy.Event:
        """Fires the next time this station's queue gets shorter. Processed
        after the grant itself, so a waiter re-reading `queue` sees the new
        length."""
        return self._queue_changed

    def _notify_queue_changed(self) -> None:
        event, self._queue_changed = self._queue_changed, self.env.event()
        event.succeed()

    def _schedule_dispatch(self) -> None:
        # Deferred to the end of the current instant, so machines that free
        # up at the same moment are all seen together and the turn order
        # decides between them.
        if self._dispatch_pending or not self._waiting:
            return
        self._dispatch_pending = True
        self.env.timeout(0).callbacks.append(lambda _: self._dispatch())

    # ------------------------------------------------------------------
    # Aggregate properties — drop-in replacements for what call sites used
    # to read directly off the single Machine/PriorityResource.
    # ------------------------------------------------------------------

    @property
    def count(self) -> int:
        return sum(sm.count for sm in self.sub_machines)

    @property
    def queue(self) -> list:
        # Jobs waiting at a parallel group for the next free machine are
        # queued here, not on any one machine.
        combined: list = list(self._waiting)
        for sm in self.sub_machines:
            combined.extend(sm.queue)
        return combined

    @property
    def failure_count(self) -> int:
        return sum(sm.failure_count for sm in self.sub_machines)

    @property
    def pm_count(self) -> int:
        return sum(sm.pm_count for sm in self.sub_machines)

    @property
    def failure_counts_per_machine(self) -> list:
        """Each sub-machine's own failure count, so dashboard KPIs (MTBF,
        Availability) can compute per-machine values instead of treating
        the pooled total as if the whole station went down on every
        failure — only true at capacity=1."""
        return [sm.failure_count for sm in self.sub_machines]


class _GroupRequest:
    """Context manager wrapping one SubMachine's request(), yielding
    (request_event, sub_machine) so the caller learns which machine it got."""

    def __init__(self, sub_machine: SubMachine, priority: int):
        self._sub_machine = sub_machine
        self.sub_machine = sub_machine
        self._req_ctx = sub_machine.request(priority=priority)

    def __enter__(self):
        req = self._req_ctx.__enter__()
        return req, self._sub_machine

    def __exit__(self, exc_type, exc_val, exc_tb):
        return self._req_ctx.__exit__(exc_type, exc_val, exc_tb)


class _PinnedRequest:
    """A job's request for one chosen SubMachine of a group (see
    MachineGroup.request_machine). Leaving it lets a parallel group hand the
    machine to whoever waits at the group."""

    def __init__(self, group: MachineGroup, sub_machine: SubMachine, priority: int):
        self._group = group
        self.sub_machine = sub_machine
        self._req_ctx = sub_machine.request(priority=priority)

    def __enter__(self):
        return self._req_ctx.__enter__(), self.sub_machine

    def __exit__(self, exc_type, exc_val, exc_tb):
        result = self._req_ctx.__exit__(exc_type, exc_val, exc_tb)
        if len(self._group.sub_machines) > 1:
            self._group._schedule_dispatch()
        return result


class _CyclicRequest:
    """A job's request to a parallel MachineGroup. It waits at the group
    until MachineGroup._dispatch picks a machine for it (cyclic order), so
    which SubMachine it gets is only known once the returned event fires —
    read it from `sub_machine` then."""

    def __init__(self, group: MachineGroup, priority: int, seq: int):
        self._group = group
        self.priority = priority
        self.seq = seq
        self.sub_machine: Optional[SubMachine] = None
        self._event = group.env.event()
        self._req_ctx = None

    def _grant(self, sub_machine: SubMachine) -> None:
        # The machine is free, so its own request is granted on the spot.
        self.sub_machine = sub_machine
        self._req_ctx = sub_machine.request(priority=self.priority)
        self._event.succeed()

    def __enter__(self):
        self._group._waiting.append(self)
        self._group._dispatch()
        return self._event, self.sub_machine

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._req_ctx is None:
            # Left before getting a machine.
            if self in self._group._waiting:
                self._group._waiting.remove(self)
                self._group._notify_queue_changed()
            return None
        result = self._req_ctx.__exit__(exc_type, exc_val, exc_tb)
        self._group._schedule_dispatch()
        return result
