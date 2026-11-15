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
import re
import simpy
import random
import statistics as stats_lib
from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple

from .machine import MachineGroup, FailurePolicy, ROUTING_SEED
from .timing_engine import TimingEngine
from .worker_pool import WorkerPool, WorkerToken, PoolRejected
from .state_stats import buffer_states, record, station_states
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

# ── Station types with non-machine behaviour ─────────────────────────────────
# Most stations are real processing machines: they hold a job for its cycle
# time, occupy an operator, can break down, need setup on changeover, and can
# require rework. A few Object Palette types are NOT machines and must not be
# modelled as one:
#
#   Connector — a pure routing junction. A job passes straight through with
#               zero delay: no capacity contention, no operator, no failure,
#               no setup, no rework. Used only to shape the flow graph.
#   Conveyor  — material transport. A job takes a transport time to traverse
#               it, up to "Conveyor Capacity" jobs ride it at once (see
#               ConveyorBelt), it consumes no operator, and it has no
#               changeover or rework.
#
# Read from stations_data[name]["Station Type"], which the Canvas writes when
# a scenario is saved. Absent (every Excel/YAML-imported scenario, and any
# scenario saved before these types existed) → treated as a normal machine,
# so existing scenarios behave exactly as before.
STATION_TYPE_CONNECTOR = "Connector"
STATION_TYPE_CONVEYOR = "Conveyor"
# Worker, Worker Controller, AND Workplace are all canvas-only annotation
# nodes — none of them is itself a work station, so all three pass through
# with zero time/capacity, same as Connector:
#   Worker            — picks which named operator (from operators_data) is
#                        assigned; contributes into whichever Worker
#                        Controller's pool it's wired to.
#   Worker Controller — the live dispatch pool/brain (see worker_pool.py).
#   Workplace         — sits beside ONE real station (wired via an edge:
#                        Station -> Workplace -> Worker Controller) and is
#                        that station's staffing point — the propagation at
#                        save time (Canvas.tsx) walks THROUGH the Workplace
#                        to write "Worker Controller" onto the REAL station
#                        it's paired with, not onto the Workplace itself.
STATION_TYPE_WORKER = "Worker"
STATION_TYPE_WORKER_CONTROLLER = "Worker Controller"
STATION_TYPE_WORKPLACE = "Workplace"
# Per the CT/PT/ST spec's object-specific behavior table: Source/Start
# ("usually no" Process Time), Drain/End, and Buffer all take no Process
# Time and no Setup Time — unlike Connector/Worker/etc. these three are
# still meaningful flow points (entity creation, final exit, queue/wait),
# but neither carries the "do work for a duration" behavior _perform_operation
# implements, so they pass through the same zero-time path.
STATION_TYPE_SOURCE = "Source"
STATION_TYPE_DRAIN = "Drain"
STATION_TYPE_BUFFER = "Buffer"


def _station_type(station: Dict[str, Any]) -> str:
    """Normalised "Station Type" for a stations_data entry ("" when unset)."""
    return str(station.get("Station Type") or "").strip()


def _is_passthrough(station: Dict[str, Any]) -> bool:
    """True for Connector/Worker/Worker Controller/Workplace/Source/Drain/
    Buffer — zero Process Time, zero Setup Time nodes. Connector/Worker/
    Worker Controller/Workplace are canvas-only annotations that don't
    represent a real station at all; Source, Drain, and Buffer ARE real
    flow points (entity creation, exit, queueing) but per the CT/PT/ST
    spec's object-specific behavior table take no Process Time or Setup
    Time of their own, so they share the same zero-time path."""
    return _station_type(station) in (
        STATION_TYPE_CONNECTOR, STATION_TYPE_WORKER, STATION_TYPE_WORKER_CONTROLLER, STATION_TYPE_WORKPLACE,
        STATION_TYPE_SOURCE, STATION_TYPE_DRAIN, STATION_TYPE_BUFFER,
    )


def _is_buffer(station: Dict[str, Any]) -> bool:
    """True for a Buffer node — a passthrough that still occupies space, so
    its Buffer Capacity limits how many jobs can wait in it (see
    _process_variant's hand-off)."""
    return _station_type(station) == STATION_TYPE_BUFFER


def _is_conveyor(station: Dict[str, Any]) -> bool:
    """True for Conveyor — transport delay, no operator, Conveyor Capacity slots."""
    return _station_type(station) == STATION_TYPE_CONVEYOR


def _is_worker_controller(station: Dict[str, Any]) -> bool:
    """True for Worker Controller — the station whose "Pool Workers" list
    becomes a live WorkerPool (see _init_worker_pools)."""
    return _station_type(station) == STATION_TYPE_WORKER_CONTROLLER


def _positive_float(raw: Any) -> Optional[float]:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _transport_time(station: Dict[str, Any], fallback: Any) -> Any:
    """
    A conveyor's traverse time = Length / Speed, the two values the user
    gives. An older conveyor saved with Length + "Transport Time" (no Speed)
    uses that Transport Time, so it rides exactly as before; failing both,
    the process-flow step's own duration, so it still moves jobs in a
    sensible time rather than zero.
    """
    length = _positive_float(station.get("Conveyor Length"))
    speed = _positive_float(station.get("Conveyor Speed"))
    if length is not None and speed is not None:
        return length / speed
    value = _positive_float(station.get("Transport Time"))
    if value is not None:
        return value
    return fallback


def _conveyor_speed(station: Dict[str, Any]) -> Optional[float]:
    """Belt speed (m/min) = Length / transport time; None if either is unset."""
    length = _positive_float(station.get("Conveyor Length"))
    transport = _transport_time(station, None)
    return length / transport if length is not None and transport else None


def _sensor_position(station: Dict[str, Any]) -> Optional[float]:
    """
    Where a conveyor's sensor sits, in m from the start of the belt — the
    user's "Conveyor Sensor Length" measured from the start ("Front") or from
    the end ("Rear"). None when there is no sensor, or it isn't on the belt.
    """
    if not _is_conveyor(station):
        return None
    length = _positive_float(station.get("Conveyor Length"))
    try:
        sensor = float(station.get("Conveyor Sensor Length"))
    except (TypeError, ValueError):
        return None
    if length is None or not 0 <= sensor <= length:
        return None
    rear = str(station.get("Conveyor Sensor Position", "Front")).strip().lower() == "rear"
    return length - sensor if rear else sensor


def _conveyor_capacity(station: Dict[str, Any]) -> int:
    """
    How many jobs a conveyor holds at once ("Conveyor Capacity"). Absent or
    blank (a conveyor saved before this field existed) means 1. 0 means no
    job can ever get on — the Canvas refuses to save that, but an imported
    scenario could still carry it.
    """
    raw = station.get("Conveyor Capacity")
    if raw in (None, ""):
        return 1
    try:
        return max(0, int(float(raw)))
    except (TypeError, ValueError):
        return 1


class ConveyorBelt:
    """
    The jobs on one Conveyor, front first. First on is first off: a job that
    has finished its transport time still waits for the jobs ahead of it.

    The whole belt stops while its front job has reached the end but cannot
    leave yet (the next station hasn't taken it). Every job riding it pauses
    and, once the front job leaves, only finishes its remaining transport
    time. A new job can still get on a stopped belt if there is a free spot
    (capacity is the conveyor's own resource slots); it just doesn't move.
    """

    def __init__(self, env: simpy.Environment):
        self.env = env
        self.jobs: List[Any] = []
        self.stopped = False
        self._stopped_by: Any = None
        # Processes asleep mid-transport — interrupted when the belt stops so
        # each can bank the time it actually travelled.
        self._riding: set = set()
        self._changed = env.event()

    def get_on(self, token: Any) -> None:
        self.jobs.append(token)

    def get_off(self, token: Any) -> None:
        if token in self.jobs:
            self.jobs.remove(token)
        if token is self._stopped_by:
            self.stopped = False
            self._stopped_by = None
        self._notify()

    def stop(self, token: Any) -> None:
        """The front job (token) is stuck at the end — stop every rider."""
        self.stopped = True
        self._stopped_by = token
        for proc in list(self._riding):
            if proc.is_alive:
                proc.interrupt("conveyor stopped")
        self._riding.clear()

    def ride_start(self, proc: Any) -> None:
        self._riding.add(proc)

    def ride_end(self, proc: Any) -> None:
        self._riding.discard(proc)

    def changed(self) -> simpy.Event:
        """Fires the next time a job gets off (the belt may restart, or a
        new job may now be at the front)."""
        return self._changed

    def _notify(self) -> None:
        event, self._changed = self._changed, self.env.event()
        event.succeed()


class _BeltSlot:
    """A conveyor slot held by its finished front job until the next station
    takes it (hold_slot) — releasing it also takes the job off the belt, which
    restarts the belt."""

    def __init__(self, req_ctx: Any, belt: ConveyorBelt, token: Any):
        self._req_ctx = req_ctx
        self._belt = belt
        self._token = token

    def __exit__(self, *exc):
        self._req_ctx.__exit__(*exc)
        self._belt.get_off(self._token)


class _HeldBlocked:
    """A station slot held by its finished job until the next station takes
    it (hold_slot): that time is the machine's Blocked time (state_stats) —
    recorded when the slot is let go."""

    def __init__(self, slot: Any, sub_machine: Any, env: simpy.Environment):
        self._slot = slot
        self._sm = sub_machine
        self._env = env
        log = getattr(sub_machine, "state_log", None)
        if log is not None:
            log["open_block"][id(self)] = env.now

    def __exit__(self, *exc):
        log = getattr(self._sm, "state_log", None)
        if log is not None:
            start = log["open_block"].pop(id(self), None)
            if start is not None and self._env.now > start:
                record(log, "block", start, self._env.now)
        return self._slot.__exit__(*exc)


class _AssembledType(str):
    """
    The variant type of an item leaving an Assembly as its Main FE when one
    assembly takes more than 1 job from the main line: numbered by
    assemblies (a-A001, a-A002, ...) so the numbers don't skip the jobs that
    went in as parts — and never clash with their names. Its str value
    ("a-A") is the internal key form.
    """

    def __new__(cls, base: str) -> "_AssembledType":
        obj = super().__new__(cls, f"{base}-A")
        obj.base = base
        return obj


class _PieceType(str):
    """
    The variant type of a piece leaving a Dismantle station. Its str value is
    the piece's name ("Car A" for Create FE, "Car" for Detach FE); job_id is
    the piece's own job id (Car A-001, or Car-001 / Car-001-2), so pieces of
    the same name never share one.
    """

    def __new__(cls, name: str, job_id: str) -> "_PieceType":
        obj = super().__new__(cls, name)
        obj.job_id = job_id
        return obj


def _format_job_id(variant_type: str, variant_id: int) -> str:
    """
    Stable, human-readable job identifier — e.g. "ProductA-003" — derived
    from the same (variant_type, variant_id) pair already used internally
    as the job_log/completion_log key, just formatted for display instead
    of the raw "producta 3" dict-key form. An assembled Main FE: "a-A001".
    """
    if isinstance(variant_type, _PieceType):
        return variant_type.job_id
    if isinstance(variant_type, _AssembledType):
        clean_base = "".join(ch for ch in variant_type.base if ch.isalnum()) or variant_type.base
        return f"{clean_base}-A{variant_id:03d}"
    clean_type = "".join(ch for ch in variant_type if ch.isalnum()) or variant_type
    return f"{clean_type}-{variant_id:03d}"


def _determine_delay_reason(
    blocked_time: float,
    station_downtime: float,
    operator_downtime: float,
    setup_time: float,
    material_unavailable: float,
    rework_time: float,
    pause_time: float = 0.0,
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

    pause_time (off-shift waiting for the next shift to start) defaults to
    0.0 so existing call sites that don't pass it keep behaving exactly as
    before — but a job that pauses hundreds of minutes overnight/over a
    weekend needs this counted, otherwise it falls through to "No delay"
    despite genuinely losing most of its Cycle Time to a shift gap.
    """
    candidates = [
        (station_downtime, "Machine breakdown"),
        (operator_downtime, "Waiting for operator"),
        (material_unavailable, "Waiting for material"),
        (setup_time, "Changeover in progress"),
        (rework_time, "Rework"),
        (blocked_time, "Waiting in queue — station busy"),
        (pause_time, "Waiting for next shift"),
    ]
    duration, reason = max(candidates, key=lambda c: c[0])
    return reason if duration > 0 else "No delay"


class RackBuffer:
    """
    Physical X/Y/Z buffer: X * Z lanes, each a Y-deep stack — like a real
    gravity-flow pallet rack. Unlike a plain scalar Buffer Capacity (a
    single count with no internal structure), a job placed behind another
    one in the same lane is physically stuck: it cannot be picked until
    everything in front of it in that lane is removed, even if OTHER lanes
    have free slots or ready-to-pick items. This is the one behaviour a
    scalar buffer structurally cannot express. Only active for a Buffer
    node whose "Buffer Config Mode" is "3D" (see _init_buffer_boxes) — a 2D
    Buffer keeps using the plain scalar Buffer Capacity path untouched.

    Placement: fills across X (and Z) FIRST, one job per lane, before going
    deeper into Y — i.e. every lane gets its 1st slot filled before any
    lane's 2nd slot is used, then every lane's 2nd slot before any 3rd, and
    so on. A new job always goes into whichever lane currently holds the
    FEWEST jobs (ties broken by lowest lane index), which produces exactly
    that fill pattern.

    Retrieval mirrors the fill order: whichever occupied slot was filled
    FIRST overall (across the whole rack, not just within one lane) is the
    next one picked — same as "first in, first out" but applied to the
    whole rack's fill order rather than per-lane. A job can only ever be
    picked once it's at the front of its own lane, so one stuck behind
    another in the same lane still waits its turn regardless of other
    lanes' state. Which lane front leaves next (FIFO/LIFO) is decided by
    BufferBox, which owns the rack.
    """

    def __init__(self, width: int, depth: int, height: int):
        self.width = max(1, width)
        self.depth = max(1, depth)
        self.height = max(1, height)
        self.lane_count = self.width * self.height
        # Each lane is a list acting as a physical stack: index 0 = front
        # (pickable), last index = back (most recently placed).
        self.lanes: List[List[Any]] = [[] for _ in range(self.lane_count)]
        # Monotonically increasing fill counter — stamped onto every token's
        # lane position at put() time via _fill_order, so retrieval can tell
        # which of several ready (front-of-lane) tokens was placed earliest
        # across the WHOLE rack, not just within its own lane.
        self._next_fill_seq = 0
        self._fill_order: List[List[int]] = [[] for _ in range(self.lane_count)]

    @property
    def total_capacity(self) -> int:
        return self.lane_count * self.depth

    @property
    def occupied(self) -> int:
        return sum(len(lane) for lane in self.lanes)

    def has_room(self) -> bool:
        return any(len(lane) < self.depth for lane in self.lanes)

    def put(self, token: Any) -> int:
        """Place into whichever lane currently holds the fewest jobs (ties
        broken by lowest lane index) — fills every lane's 1st slot before
        any lane's 2nd slot, every 2nd before any 3rd, and so on. Returns
        the lane index used."""
        candidates = [i for i in range(self.lane_count) if len(self.lanes[i]) < self.depth]
        if not candidates:
            raise RuntimeError("RackBuffer.put() called with no room — caller must check has_room() first")
        best = min(candidates, key=lambda i: (len(self.lanes[i]), i))
        self.lanes[best].append(token)
        self._fill_order[best].append(self._next_fill_seq)
        self._next_fill_seq += 1
        return best

    def ready_lane(self) -> Optional[int]:
        """Index of whichever lane's front slot (a) is occupied and (b) was
        filled earliest across the whole rack — not just the first lane
        found, so retrieval empties the rack in the same X-then-Y order it
        was filled in, mirroring put()'s fill order."""
        best_idx: Optional[int] = None
        best_seq: Optional[int] = None
        for i, lane in enumerate(self.lanes):
            if not lane:
                continue
            seq = self._fill_order[i][0]
            if best_seq is None or seq < best_seq:
                best_idx, best_seq = i, seq
        return best_idx

    def get(self) -> Any:
        """Remove and return the front item of whichever ready lane was
        filled earliest overall (physical pick)."""
        i = self.ready_lane()
        if i is None:
            raise RuntimeError("RackBuffer.get() called with nothing ready — caller must check ready_lane() first")
        return self.get_from_lane(i)

    def get_from_lane(self, lane_idx: int) -> Any:
        """Remove and return the front item of a specific lane (used once a
        caller has confirmed its own token is that lane's front item)."""
        self._fill_order[lane_idx].pop(0)
        return self.lanes[lane_idx].pop(0)


# "Not decided yet" — see _process_variant's handed_allowed.
_UNSET = object()


def _branch_slots(steps: List[Dict[str, Any]]) -> List[List[int]]:
    """
    Group a variant's steps into slots — the stops a job makes in order. A
    plain step is a slot of its own. Consecutive steps sharing a "branch"
    value are one split: a job visits only ONE of them, picked by the
    previous station's Exit Controller (see BranchRouter). Steps without
    "branch" (every scenario saved before splits existed) stay one per slot.
    """
    slots: List[List[int]] = []
    for i, step in enumerate(steps):
        branch = step.get("branch")
        if branch is not None and slots and steps[slots[-1][0]].get("branch") == branch:
            slots[-1].append(i)
        else:
            slots.append([i])
    return slots


class BranchRouter:
    """
    Exit Controller for a split: a station whose next step is one of several
    different stations (Station 1 -> Station 2 / 3 / 4). Every machine of
    those stations is one choice — a parallel station's #1, #2 count
    separately — in step order. Same rules as a parallel station's own
    dispatch (MachineGroup._dispatch):
      cyclic    — in turn; a busy machine is skipped, the turn carries on
                  after whichever machine got the job.
      random    — a random free machine (own fixed seed, so runs repeat).
      successor — the best-priority free machine ("Exit Priorities").
    Busy = working on a job, or down for failure/PM. A station's own buffer
    is not used here: a job only goes to a free machine, and waits on the
    sending station while every choice is busy.
    """

    def __init__(
        self,
        options: List[Tuple[int, str, MachineGroup]],
        strategy: str,
        priority_order: Optional[List[int]] = None,
        line: Optional["ParallelLine"] = None,
    ):
        # One choice per machine: (step index, station, group, machine index).
        self.choices: List[Tuple[int, str, MachineGroup, int]] = [
            (step_idx, station, group, m)
            for step_idx, station, group in options
            for m in range(len(group.sub_machines))
        ]
        self.groups = [group for _, _, group in options]
        self.strategy = strategy
        self.order = priority_order or list(range(len(self.choices)))
        self._rng = random.Random(ROUTING_SEED)
        self._next_turn = 0
        # Set when every choice is a machine of one parallel group: jobs
        # wait in the group's shared line instead of on the sending station.
        self.line = line

    def labels(self) -> List[str]:
        """Each choice as its box is named on the Canvas: the station, or
        "Station #2" for machine 2 of a station with several machines."""
        return [
            station if len(group.sub_machines) == 1 else f"{station} #{m + 1}"
            for _, station, group, m in self.choices
        ]

    def pick(self, allowed: Optional[set] = None) -> Optional[Tuple[int, str, MachineGroup, int]]:
        """The choice a job leaving now gets, or None while every one is busy.
        `allowed`: the choices (indexes) this job may take — Route by product
        on the sending station; None = any. A busy allowed choice is skipped,
        like any busy one."""
        n = len(self.choices)
        free = [k for k in range(n)
                if (allowed is None or k in allowed) and self.choices[k][2].machine_is_free(self.choices[k][3])]
        if not free:
            return None
        if self.strategy == "random":
            k = self._rng.choice(free)
        elif self.strategy == "successor":
            k = next(k for k in self.order if k in free)
        else:
            k = next((self._next_turn + j) % n for j in range(n) if (self._next_turn + j) % n in free)
        self._next_turn = (k + 1) % n
        return self.choices[k]


class ParallelLine:
    """
    The one waiting line shared by the machines of a parallel group
    (stations with the same "Parallel Group": Station 2 #1, #2, #3 — each a
    station of its own, with its own settings). A job that finds every
    machine busy waits here — freeing the station it came from — and goes to
    the first machine that frees up. Room = the machines' Buffer Capacity
    added together (None = unlimited, if any machine's buffer is); with 0
    the job waits on the station it came from instead, like a split.
    First in, first out.
    """

    def __init__(self, env: simpy.Environment, capacity: Optional[int]):
        self.env = env
        self.capacity = capacity
        self.jobs: List[Any] = []
        self._changed = env.event()

    def has_room(self) -> bool:
        return self.capacity is None or len(self.jobs) < self.capacity

    def head(self) -> Any:
        return self.jobs[0] if self.jobs else None

    def join(self, token: Any) -> None:
        self.jobs.append(token)
        self._notify()

    def leave(self, token: Any) -> None:
        self.jobs.remove(token)
        self._notify()

    def changed(self) -> simpy.Event:
        """Fires the next time a job joins or leaves."""
        return self._changed

    def _notify(self) -> None:
        event, self._changed = self._changed, self.env.event()
        event.succeed()


class AssemblyRoom:
    """
    The waiting room of an Assembly station: room for the parts one assembly
    needs besides its main part — per kind of part ("line:<station>" for
    Predecessors / None, "fe:<product>" for Flow Entity), as many as one
    assembly takes. A part that finds its kind full waits where it is (its
    station stays blocked); the main part sits on the Assembly machine until
    every kind is complete, then takes them all. Taken parts keep their
    places until that assembly has left the machine (release), so the next
    assembly's parts wait on their own stations meanwhile.
    """

    def __init__(self, env: simpy.Environment, needs: Dict[str, int]):
        self.env = env
        self.needs = dict(needs)
        self.parts: Dict[str, List[Any]] = {k: [] for k in self.needs}
        # Places still held by assemblies on the machine: main job -> per kind.
        self.in_work: Dict[str, Dict[str, int]] = {}
        self._waiters: List[simpy.Event] = []

    def has_room(self, key: str) -> bool:
        held = sum(counts.get(key, 0) for counts in self.in_work.values())
        return len(self.parts[key]) + held < self.needs[key]

    def put(self, key: str, part: Any) -> None:
        self.parts[key].append(part)
        self._notify()

    def complete(self) -> bool:
        return all(len(self.parts[k]) >= n for k, n in self.needs.items())

    def take(self, main_job: str) -> List[Any]:
        taken: List[Any] = []
        for key, n in self.needs.items():
            taken += self.parts[key][:n]
            self.parts[key] = self.parts[key][n:]
        self.in_work[main_job] = dict(self.needs)
        return taken

    def release(self, main_job: str) -> None:
        """main_job's assembly has left the machine: its places open."""
        if self.in_work.pop(main_job, None) is not None:
            self._notify()

    def changed(self) -> simpy.Event:
        """Fires the next time a part comes in or is taken."""
        ev = self.env.event()
        self._waiters.append(ev)
        return ev

    def _notify(self) -> None:
        waiters, self._waiters = self._waiters, []
        for ev in waiters:
            if not ev.triggered:
                ev.succeed()


class BufferBox:
    """
    A Buffer node on the Canvas: holds finished jobs between two stations and
    takes no time.

    2D: `capacity` jobs (None = unlimited). 0 = no waiting room at all — a job
        never sits in the box; the station before keeps it until the station
        after takes it, as if the box weren't there.
    3D: a RackBuffer (X*Z lanes, Y deep). Capacity is X*Y*Z, and only the job
        at the front of its lane can leave.

    Entering: a job gets a place as soon as there is room, else waits
    (first come, first placed) — the station it came from stays blocked.
    Leaving: of the jobs allowed to leave (every job in 2D, lane fronts in
    3D), FIFO sends the earliest-entered, LIFO the latest-entered.
    """

    def __init__(self, env: simpy.Environment, capacity: Optional[int], discipline: str,
                 rack: Optional[RackBuffer] = None):
        self.env = env
        self.rack = rack
        self.capacity = rack.total_capacity if rack is not None else capacity
        self.lifo = str(discipline or "FIFO").strip().upper() == "LIFO"
        self.items: List[Any] = []
        self._seq = 0
        self.seq: Dict[Any, int] = {}
        self.entered_at: Dict[Any, float] = {}
        self.lane: Dict[Any, int] = {}
        self._room_waiters: deque = deque()  # (event, token), first come first placed
        self._changed = env.event()
        self.full_time = 0.0
        self._full_since: Optional[float] = None
        # Statistical analysis: when it held parts but had room ("occupied")
        # and when it was full — Empty is the rest (state_stats.buffer_states).
        self.level_log: Dict[str, List[Tuple[float, float]]] = {"occupied": [], "full": []}
        self._level = "empty"
        self._level_since = 0.0

    @property
    def passes_through(self) -> bool:
        """Capacity 0: no job ever waits inside."""
        return self.capacity == 0

    def has_room(self) -> bool:
        if self.rack is not None:
            return self.rack.has_room()
        return self.capacity is None or len(self.items) < self.capacity

    def enter(self, token: Any):
        """Generator: place `token` as soon as there is room."""
        if self.has_room() and not self._room_waiters:
            self._place(token)
            return
        event = self.env.event()
        self._room_waiters.append((event, token))
        yield event  # _place()d by leave() before this fires

    def may_leave(self, token: Any) -> bool:
        """It's this job's turn to leave: chosen by FIFO/LIFO among the jobs
        that can physically leave (lane fronts in 3D)."""
        return self.next_out() is token

    def next_out(self) -> Any:
        candidates = self.items if self.rack is None else [
            lane[0] for lane in self.rack.lanes if lane
        ]
        if not candidates:
            return None
        pick = max if self.lifo else min
        return pick(candidates, key=lambda t: self.seq[t])

    def priority(self, token: Any) -> float:
        """Request priority on the next station: lower is served first. In
        minutes, like a station's own FIFO (0) / LIFO (-arrival time), so jobs
        from this box and from other feeders of that station compare fairly.
        The tiny seq term orders jobs that entered in the same minute."""
        if self.lifo:
            return -(self.entered_at[token] + self.seq[token] * 1e-9)
        if self.rack is None:
            # 2D: every job queues the moment it enters, so plain request
            # order is already FIFO.
            return 0
        # 3D: a job only queues once it reaches its lane front, which can be
        # after a later-entered job in another lane — order by entry instead.
        return self.entered_at[token] + self.seq[token] * 1e-9

    def is_front(self, token: Any) -> bool:
        return self.rack is None or self.rack.lanes[self.lane[token]][0] is token

    def leave(self, token: Any) -> None:
        if self.rack is not None:
            lane = self.lane.pop(token)
            assert self.rack.lanes[lane][0] is token
            self.rack.get_from_lane(lane)
        self.items.remove(token)
        self.seq.pop(token, None)
        self.entered_at.pop(token, None)
        # A freed place goes to the longest-waiting arrival first.
        while self._room_waiters and self.has_room():
            event, waiting = self._room_waiters.popleft()
            self._place(waiting)
            event.succeed()
        self._track_full()
        self._notify()

    def changed(self) -> simpy.Event:
        """Fires the next time a job enters or leaves."""
        return self._changed

    def _place(self, token: Any) -> None:
        self.items.append(token)
        self.entered_at[token] = self.env.now
        self.seq[token] = self._seq
        self._seq += 1
        if self.rack is not None:
            self.lane[token] = self.rack.put(token)
        self._track_full()
        self._notify()

    def _track_level(self) -> None:
        level = "empty" if not self.items else ("full" if not self.has_room() else "occupied")
        if level != self._level:
            if self._level != "empty":
                record(self.level_log, self._level, self._level_since, self.env.now)
            self._level, self._level_since = level, self.env.now

    def level_intervals(self, end: float) -> Dict[str, List[Tuple[float, float]]]:
        """Occupied / full intervals up to `end` (an open one included)."""
        out = {k: list(v) for k, v in self.level_log.items()}
        if self._level != "empty" and end > self._level_since:
            out[self._level].append((self._level_since, end))
        return out

    def _track_full(self) -> None:
        self._track_level()
        full = not self.has_room()
        if full and self._full_since is None:
            self._full_since = self.env.now
        elif not full and self._full_since is not None:
            self.full_time += self.env.now - self._full_since
            self._full_since = None

    def full_time_until(self, now: float) -> float:
        """Minutes the box was full, counting a still-open full spell."""
        return self.full_time + (now - self._full_since if self._full_since is not None else 0.0)

    def _notify(self) -> None:
        event, self._changed = self._changed, self.env.event()
        event.succeed()


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
        stop_check: Optional[Callable[[], bool]] = None,
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
        # Polled from the stepped env.run() loop in _run_simpy — True means
        # the Stop button was pressed for this run (see progress_store's
        # is_stop_requested). No thread-kill involved: the sim just checks
        # this at its existing checkpoints and raises SimulationStopped to
        # unwind cleanly, same as any other exception path.
        self.stop_check = stop_check or (lambda: False)

        # Runtime state (reset on each run)
        self.env: Optional[simpy.Environment] = None
        self.resources: Dict[str, MachineGroup] = {}
        self.worker_pools: Dict[str, WorkerPool] = {}
        self.job_log: Dict[str, List] = {}
        self.completion_log: Dict[str, List] = {}
        self.bottleneck_store: Dict[str, Any] = {}
        self.simulation_state: Dict[str, Any] = {}
        self.cycle_times: Dict[str, float] = {}
        self.timing = TimingEngine()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self) -> Dict[str, Any]:
        """Execute the simulation and return results."""
        # Random Seed — PDF section 13's reliability panel: "Auto" (the
        # default — RANDOM_SEED absent/None/blank) leaves every run's
        # failure/repair timing genuinely random, same as today's existing
        # behavior. Setting an explicit integer here makes a run's random
        # draws (failure timing, repair timing, routing ties, etc.)
        # reproducible across repeated runs of the same scenario — useful
        # for comparing two configs apples-to-apples, or for reliably
        # reproducing a specific failure pattern for testing (the same need
        # test_failure_policy_manual.py's run_until_hit() works around by
        # trying a list of seeds).
        seed = self.sim_config.get("RANDOM_SEED")
        if seed not in (None, "", "auto", "Auto"):
            random.seed(int(seed))
        self._validate_config()
        self._reset_state()
        self._check_route_by_product()
        self._check_conveyor_sensors()
        self._check_assemblies()
        self._find_dismantle_exits()
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
        self._log_variant_cycle_times()
        return result

    def _log_variant_cycle_times(self):
        """
        Per-variant "complete cycle time" summary, logged once per run — for
        each variant, sum one job's per-station Cycle Time entries (already
        computed per station-visit — see _perform_operation's trace_entry,
        stored per station in self.completion_log) across every station it
        visited, giving an approximate total elapsed time for that job
        start-to-finish; then average that across every completed job of the
        variant. This is assembled entirely from the existing per-station CT
        numbers — it does NOT introduce the doc's separate whole-job/Drain
        "Final entity CT" metric, which remains deliberately unimplemented
        (per-station CT only, as decided).
        """
        # job_id (e.g. "widget-001") -> sum of "Cycle Time" across every
        # station visit that job completed.
        job_totals: Dict[str, float] = {}
        for entries in self.completion_log.values():
            for e in entries:
                if e.get("status") != "Completed":
                    continue
                job_id = e.get("job_id")
                if not job_id:
                    continue
                job_totals[job_id] = job_totals.get(job_id, 0.0) + e.get("Cycle Time", 0)

        # Group job totals by variant TYPE — job_id is "{CleanType}-{003}".
        variant_job_totals: Dict[str, list] = {}
        for job_id, total in job_totals.items():
            variant_type = job_id.rsplit("-", 1)[0] if "-" in job_id else job_id
            variant_job_totals.setdefault(variant_type, []).append(total)

        for variant_type, totals in variant_job_totals.items():
            if not totals:
                continue
            avg_total = sum(totals) / len(totals)
            logger.info(
                "[run_complete] variant=%s jobs=%d avg_complete_cycle_time=%.2f min "
                "(sum of per-station Cycle Time across all stations visited, averaged over completed jobs)",
                variant_type, len(totals), avg_total,
            )

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
            # A stop mid-replication already cut that replication's own
            # _run_simpy loop short (see stop_check there) — this additional
            # check just stops us from starting a WHOLE NEW replication
            # after the button was pressed, rather than running num_replications
            # regardless.
            if result.get("simulation_state", {}).get("stopped_early"):
                break

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
            "rejected_jobs": 0,
            "scrapped_jobs": 0,
            "job_count": 0,
            "current_jobs": {},
            "running_jobs": [],
            "job_exit_times": {},
            # job_id -> when it entered the line / finished its whole route
            # (finished only if it did) — the Canvas job replay shows a job at
            # Start before its first station and at End once it's done.
            "job_release_times": {},
            "job_finish_times": {},
            # Assembly: parts used up / attached at an Assembly (not
            # completed jobs), each assembly made (out job -> its parts),
            # and the problems found before the run that don't stop it.
            "assembled_parts": 0,
            "assemblies": {},
            # Dismantle: each job dismantled -> its station, mode and pieces.
            "dismantles": {},
            "warnings": [],
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
                "sensor_passed": 0,
                # Assembly: minutes its main parts sat on it waiting for parts.
                "parts_wait_time": 0,
                # After the warm-up: parts scrapped here; Dismantle: the
                # pieces (output components) it gave out.
                "scrapped_parts": 0,
                "output_components": 0,
                "job_counts": {"waiting": 0, "processing": 0, "completed": 0},
            })

        self.cycle_times = self._compute_cycle_times()
        self.resources = self._init_resources()
        self.conveyor_belts: Dict[str, ConveyorBelt] = {
            name: ConveyorBelt(self.env)
            for name, station in self.stations_data.items() if _is_conveyor(station)
        }
        self.buffer_boxes = self._init_buffer_boxes()
        # Exit Controller routers for splits, made on first use — see
        # _branch_target. Fresh each run so every replication starts its
        # turn order / random choices from the beginning.
        self.branch_routers: Dict[Tuple[Optional[str], Tuple[str, ...]], BranchRouter] = {}
        # Shared waiting line per parallel group, made on first use.
        self.parallel_lines: Dict[str, ParallelLine] = {}
        # Route by product + Cyclic: each product's own turn over its ticked
        # stations, per (station, next boxes, product).
        self.product_turns: Dict[Tuple[str, Tuple[str, ...], str], int] = {}
        # Assembly: each Assembly's waiting room (made on first use), and the
        # name a main part leaves an Assembly with (New FE), by its job id.
        self.assembly_rooms: Dict[str, AssemblyRoom] = {}
        self._assembly_out: Dict[str, Tuple[str, int]] = {}
        # Main FEs renumbered so far, per product (see _join_parts).
        self._main_fe_counts: Dict[str, int] = {}
        # Dismantle: pieces made so far, per name (Create FE: Car A-001, ...),
        # and a counter giving Detach FE pieces their own internal number.
        self._piece_counts: Dict[str, int] = {}
        self._piece_seq = 0
        # Parts delivered by each Start / collected at the line's end (by the
        # last station they left), per product, after the warm-up.
        self._delivered: Dict[str, Dict[str, int]] = {}
        # collected: last station -> route product (the line's product) -> name.
        self._collected: Dict[str, Dict[str, Dict[str, int]]] = {}
        self._start_cache: Dict[str, Optional[str]] = {}
        # Filled by _find_dismantle_exits (before the run).
        self._dismantle_exits: Dict[str, List[Tuple[str, str, int, int]]] = {}
        # Main-line jobs on their way to each Assembly so far (see
        # _decide_assembly_role).
        self._main_turns: Dict[str, int] = {}
        # Filled by _check_assemblies (before the run).
        self.assembly_specs: Dict[str, Dict[str, Any]] = {}
        self._assembly_roles: Dict[Tuple[str, str, int], Tuple[str, Optional[str]]] = {}
        self.worker_pools = self._init_worker_pools()
        # Build case-insensitive/stripped lookup: normalized_key → original station key
        self._resource_key_map: Dict[str, str] = {
            k.lower().strip(): k for k in self.stations_data
        }
        self._apply_exit_strategies()
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

    def _resolve_step_resource(self, step: Dict[str, Any], variant_type: str) -> Optional[str]:
        """
        Resolve a process-flow step's destination station. `step["resource"]`
        is a plain station name. Scenarios saved while the Exit Controller
        existed may still hold a {"mode", "options", ...} dict — those run on
        their first resolvable option only.
        """
        raw = step.get("resource")
        if isinstance(raw, str):
            return self._resolve_resource(raw)
        if not isinstance(raw, dict):
            return None
        for option in raw.get("options", []):
            resolved = self._resolve_resource(option)
            if resolved is not None:
                return resolved
        return None

    def _apply_exit_strategies(self) -> None:
        """
        Exit Controller: the station BEFORE a parallel station decides how
        jobs are spread over its machines. "random" there makes the next
        station's MachineGroup pick a random free machine; "successor" makes
        it pick the best-priority free machine ("Exit Priorities"); anything
        else (incl. not set) keeps the default cyclic order. Only parallel
        stations (2+ machines) are affected. A split (next step is one of
        several stations) is routed by BranchRouter instead.
        """
        for steps in self.processflow_data.values():
            slots = _branch_slots(steps)
            for prev_slot, nxt_slot in zip(slots, slots[1:]):
                if len(prev_slot) != 1 or len(nxt_slot) != 1:
                    continue
                prev = self._resolve_step_resource(steps[prev_slot[0]], "")
                nxt = self._resolve_step_resource(steps[nxt_slot[0]], "")
                if prev is None or nxt is None:
                    continue
                strategy = str(self.stations_data[prev].get("Exit Strategy") or "").strip().lower()
                group = self.resources[nxt]
                if len(group.sub_machines) < 2:
                    continue
                if strategy == "random":
                    group.strategy = "random"
                elif strategy == "successor":
                    group.strategy = "successor"
                    order = self._exit_priority_order(self.stations_data[prev].get("Exit Priorities"), nxt, len(group.sub_machines))
                    if order is not None:
                        group.priority_order = order

    def _exit_priority_order(self, priorities: Any, station: str, n: int) -> Optional[List[int]]:
        """
        Turn the Canvas's {"Station 2 #1": 2, "Station 2 #2": 1, ...} into
        machine indexes best-first ([1, 0, ...]). Boxes are matched to
        machines in "#" number order (#1 -> first machine, ...). None (keep
        the default #1, #2, ... order) when not set or not exactly one
        priority per machine using each of 1..n once — the Canvas blocks
        saving that, so it only covers hand-edited data.
        """
        if not isinstance(priorities, dict):
            return None
        boxes = []
        for label, prio in priorities.items():
            m = re.match(r"^(.*?)(?:\s+#(\d+))?$", str(label).strip())
            if self._resolve_resource(m.group(1)) == station:
                boxes.append((int(m.group(2) or 0), prio))
        boxes.sort()
        prios = [p for _, p in boxes]
        if len(prios) != n or sorted(prios) != list(range(1, n + 1)):
            return None
        return sorted(range(n), key=lambda i: prios[i])

    def _branch_target(
        self, src: Optional[str], steps: List[Dict[str, Any]], slot: List[int],
        resolve: Callable[[int], Optional[str]],
    ) -> Optional[BranchRouter]:
        """
        The router for the split `slot` (2+ steps) entered from station `src`
        (None when the split is reached without one, e.g. as the first step).
        One per (src, stations) for the whole run, so the turn order is
        shared by every job and variant leaving src. None when fewer than two
        of the split's stations exist — the caller then runs it as a plain
        step.
        """
        options = [(i, resolve(i)) for i in slot]
        options = [(i, name) for i, name in options if name is not None]
        if len(options) < 2:
            return None
        key = (src, tuple(name for _, name in options))
        router = self.branch_routers.get(key)
        if router is None:
            cfg = self.stations_data.get(src, {}) if src is not None else {}
            strategy = str(cfg.get("Exit Strategy") or "").strip().lower()
            groups = [(i, name, self.resources[name]) for i, name in options]
            order = None
            if strategy == "successor":
                order = self._branch_priority_order(cfg.get("Exit Priorities"), groups)
            router = BranchRouter(groups, strategy, order, self._parallel_line([name for _, name in options]))
            self.branch_routers[key] = router
        return router

    def _parallel_line(self, stations: List[str]) -> Optional[ParallelLine]:
        """
        The shared waiting line when `stations` are all machines of one
        parallel group; None otherwise (a split between different stations,
        where the job waits on the station it came from).
        """
        groups = {str(self.stations_data[s].get("Parallel Group") or "").strip() for s in stations}
        if len(groups) != 1 or "" in groups:
            return None
        group = groups.pop()
        line = self.parallel_lines.get(group)
        if line is None:
            members = [self.stations_data[s] for s in stations]
            if any(m.get("Buffer Unlimited", False) for m in members):
                capacity = None
            else:
                capacity = sum(max(0, int(float(m.get("Buffer Capacity", 0) or 0))) for m in members)
            line = ParallelLine(self.env, capacity)
            self.parallel_lines[group] = line
        return line

    def _branch_priority_order(
        self, priorities: Any, groups: List[Tuple[int, str, MachineGroup]],
    ) -> Optional[List[int]]:
        """
        Turn the Canvas's {"Station 2": 2, "Station 3 #1": 1, ...} into
        BranchRouter choice indexes, best first. Choices are each station's
        machines in step order ("#" number order within a parallel station).
        None (keep that order) unless there is exactly one priority per
        choice using each of 1..n once — the Canvas blocks saving otherwise.
        """
        if not isinstance(priorities, dict):
            return None
        by_box: Dict[Tuple[str, int], Any] = {}
        for label, prio in priorities.items():
            # A machine of a parallel group is a station of its own, named
            # exactly like its box ("Station 2 #1", or whatever it was renamed to).
            station = self._resolve_resource(str(label).strip())
            if station is not None:
                by_box[(station, 0)] = prio
                continue
            m = re.match(r"^(.*?)(?:\s+#(\d+))?$", str(label).strip())
            station = self._resolve_resource(m.group(1))
            if station is not None:
                by_box[(station, int(m.group(2) or 0))] = prio
        prios = []
        for _, name, group in groups:
            n = len(group.sub_machines)
            for k in range(n):
                prios.append(by_box.get((name, k + 1 if n > 1 else 0)))
        if sorted(p for p in prios if isinstance(p, (int, float))) != list(range(1, len(prios) + 1)):
            return None
        return sorted(range(len(prios)), key=lambda k: prios[k])

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

    def _init_resources(self) -> Dict[str, MachineGroup]:
        resources = {}
        for name, station in self.stations_data.items():
            # Conveyors and Connectors are not machines: they never break down
            # and have no preventive maintenance. Passing simulation_time=None
            # suppresses failure/PM background processes entirely (see
            # machine.py) instead of relying on a 0 failure rate, which
            # would still spawn and run both processes for the whole horizon.
            is_transport = _is_conveyor(station) or _is_passthrough(station)
            # A belt carries up to its Conveyor Capacity jobs at once (one
            # spot per job); see ConveyorBelt for how they move along it.
            capacity = max(1, _conveyor_capacity(station)) if _is_conveyor(station) else station.get("capacity", 1)
            # Failure Policy — PDF section 7/8: what happens to a part's
            # remaining processing time when this station's machine fails
            # mid-operation. Not a field the UI/parsers write today, so an
            # absent/unrecognized value falls back to RESUME, the PDF's own
            # stated default ("most useful default for a manufacturing
            # simulation").
            policy_raw = str(station.get("Failure Policy", "resume") or "resume").strip().lower()
            try:
                failure_policy = FailurePolicy(policy_raw)
            except ValueError:
                failure_policy = FailurePolicy.RESUME

            # MTBF (minutes, uncapped) — the primary reliability input when
            # present, written by the Process Flow tab's Availability%+MTTR
            # fields (see ScenarioManager.tsx). Falls back to the legacy
            # "Failure rate" (0-1 daily probability) path inside machine.py
            # for scenarios saved before this field existed.
            mtbf_raw = station.get("MTBF")
            mtbf = None if is_transport or mtbf_raw in (None, "") else float(mtbf_raw)

            # Enable Failures — PDF section 13's reliability panel: an
            # explicit per-station on/off switch, so disabling failures
            # doesn't require contorting Availability to exactly 100 (which
            # also only approximately means "never fails" once MTBF is a
            # plain float rather than a 0-1 probability with a hard ceiling
            # — see availabilityPctToMtbf's clamp). Defaults to True/absent
            # for every existing scenario (unchanged behavior) — only an
            # explicit False here disables it. Reuses the exact same
            # simulation_time=None mechanism transport stations already use
            # to fully suppress the failure/PM background processes (see
            # machine.py), rather than a separate code path.
            failures_enabled = station.get("Enable Failures", True)
            no_failures = is_transport or failures_enabled is False

            resources[name] = MachineGroup(
                env=self.env,
                name=name,
                failure_rate=0 if no_failures else station.get("Failure rate", 0),
                repair_time=station.get("Repair Time", 10),
                pm_schedule=None if no_failures else station.get("PM Schedule"),
                capacity=capacity,
                job_log=self.job_log,
                simulation_time=None if no_failures else self.sim_config["SIM_TIME"],
                failure_policy=failure_policy,
                mtbf=None if no_failures else mtbf,
                # Only a belt/passthrough is one shared pool. A station with
                # failures off still has `capacity` separate machines, so the
                # Exit Controller (cyclic/random/successor) picks between them.
                pooled=is_transport,
            )
            if _is_conveyor(station) and _conveyor_capacity(station) == 0:
                # Capacity 0: SimPy needs at least 1 slot, so take that one
                # slot for good — no job can ever get on this belt.
                resources[name].sub_machines[0].request()
        return resources

    def _init_buffer_boxes(self) -> Dict[str, BufferBox]:
        """
        One BufferBox per Buffer node. "Buffer Config Mode": "3D" gives it an
        X/Y/Z RackBuffer (Canvas-only fields, each defaulting to 1); 2D (the
        default) uses Buffer Capacity, or no limit when Buffer Unlimited.
        """
        boxes = {}
        for name, station in self.stations_data.items():
            if not _is_buffer(station):
                continue
            discipline = station.get("Buffer Discipline", "FIFO")
            if station.get("Buffer Config Mode") == "3D":
                x = int(station.get("Buffer X", 1) or 1)
                y = int(station.get("Buffer Y", 1) or 1)
                z = int(station.get("Buffer Z", 1) or 1)
                rack = RackBuffer(max(1, x), max(1, y), max(1, z))
                boxes[name] = BufferBox(self.env, None, discipline, rack)
            elif station.get("Buffer Unlimited", False):
                boxes[name] = BufferBox(self.env, None, discipline)
            else:
                cap = max(0, int(station.get("Buffer Capacity", 0) or 0))
                boxes[name] = BufferBox(self.env, cap, discipline)
        return boxes

    def _init_worker_pools(self) -> Dict[str, WorkerPool]:
        """
        One WorkerPool per Worker Controller station — built from that
        Controller's "Pool Workers" list (each entry: name, availability,
        travel_time) plus its dispatch settings (Assignment Strategy, Queue
        Policy, Max Queue Size, Shift Start/End, Allow Overtime, Enabled, Use
        Worker Travel Time). A Controller with no workers wired (empty/
        missing "Pool Workers") gets no pool at all, so a Workplace naming it
        falls back to unblocked/no-gate behaviour rather than deadlocking
        forever waiting on an empty pool.
        """
        pools = {}
        for name, station in self.stations_data.items():
            if not _is_worker_controller(station):
                continue
            raw_workers = station.get("Pool Workers") or []
            if not raw_workers:
                continue
            tokens = [
                WorkerToken(
                    name=w.get("name", ""),
                    availability=float(w.get("availability", 100) or 100),
                    travel_time=float(w.get("travel_time", 0) or 0),
                )
                for w in raw_workers
            ]
            shift_start = station.get("Shift Start")
            shift_end = station.get("Shift End")
            pools[name] = WorkerPool(
                self.env, name, tokens,
                strategy=str(station.get("Assignment Strategy", "first_available") or "first_available"),
                queue_policy=str(station.get("Queue Policy", "queue") or "queue"),
                max_queue_size=station.get("Max Queue Size"),
                shift_start=float(shift_start) if shift_start not in (None, "") else None,
                shift_end=float(shift_end) if shift_end not in (None, "") else None,
                allow_overtime=bool(station.get("Allow Overtime", True)),
                enabled=bool(station.get("Enabled", True)),
                use_travel_time=bool(station.get("Use Worker Travel Time", True)),
                clock_start=(self.simulation_state["start_date"].hour * 60 + self.simulation_state["start_date"].minute
                             + self.simulation_state["start_date"].second / 60.0),
            )
        return pools

    def _run_simpy(self):
        sim_time = self.sim_config["SIM_TIME"]

        # A job whose (i-1) * interval arrival falls after SIM_TIME will
        # never get a chance to run — the simulation clock stops before it
        # arrives. Pre-creating its SimPy process anyway (the old
        # `for i in range(1, qty+1)` loop did this unconditionally) still
        # costs real setup time per job for zero effect on the result, and
        # at 200k+ jobs/variant that setup cost dominates the run. Cap how
        # many are actually spawned to those that can arrive in time —
        # arrivals are in increasing order, so once one is too late, every
        # later one is too.
        spawnable_jobs = 0
        for variant, qty in self.variant_quantities.items():
            interval = self.variant_intervals.get(variant, 0) or 0
            if interval > 0:
                max_arrivals = int(sim_time // interval) + 1
                spawnable_jobs += min(qty, max_arrivals)
            else:
                spawnable_jobs += qty
        spawnable_jobs = max(1, spawnable_jobs)

        spawned = 0
        # Start's Exit Controller: products released one batch after another.
        schedule = self._release_schedule()
        if schedule is not None:
            arrivals = [(v, i, t) for v, i, t in schedule if t <= sim_time]
            total = max(1, len(arrivals))
            report_every = max(1, total // 50)
            for variant, i, arrival in arrivals:
                self.env.process(self._delayed_spawn(i, variant, arrival))
                spawned += 1
                if spawned % report_every == 0 or spawned == total:
                    self.progress_cb(spawned / total * 0.5, f"Scheduling {variant} #{i}")
        for variant, qty in (self.variant_quantities.items() if schedule is None else ()):
            interval = self.variant_intervals.get(variant, 0) or 0
            for i in range(1, qty + 1):
                if interval > 0:
                    arrival = (i - 1) * interval
                    if arrival > sim_time:
                        # Every later i for this variant arrives even later —
                        # nothing left to spawn for it.
                        break
                    # Space this job's arrival out by (i-1) * interval minutes
                    # instead of spawning it immediately at t=0, so jobs of this
                    # variant enter the system on a fixed, predictable schedule.
                    self.env.process(self._delayed_spawn(i, variant, arrival))
                else:
                    self.env.process(self._process_variant(i, variant))
                spawned += 1
                # Report at most ~50 times total instead of once per job —
                # per-job callbacks (logger.info + progress_store.push) were
                # adding real overhead in the spawn loop for large job counts.
                report_every = max(1, spawnable_jobs // 50)
                if spawned % report_every == 0 or spawned == spawnable_jobs:
                    self.progress_cb(spawned / spawnable_jobs * 0.5, f"Scheduling {variant} #{i}")

        self.simulation_state["in_progress_jobs"] = spawned
        self.progress_cb(0.5, "Running simulation…")

        # Run in steps rather than one single env.run(until=SIM_TIME) call so
        # the simulation CLOCK's own progress (env.now vs SIM_TIME) can be
        # reported as it advances, not just the coarse pre/post-run phases
        # above and below. Each step behaves identically to one long
        # env.run() — SimPy resumes from wherever it left off — this only
        # adds checkpoints to report progress from, not different behavior.
        sim_time = self.sim_config["SIM_TIME"]
        num_steps = 20
        step = max(1.0, sim_time / num_steps)
        target = 0.0
        stopped = False
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
            # Stop button was pressed (see progress_store.request_stop) —
            # break out of the stepped loop now rather than running the
            # remaining chunks. Every job still in flight at this instant
            # simply never reaches its "Completed" trace_entry, the same
            # shape as a job cut short by hitting SIM_TIME naturally.
            if self.stop_check():
                stopped = True
                break

        self.simulation_state["stopped_early"] = stopped

        # Copy machine failure/PM counts back into station data
        for name, machine in self.resources.items():
            self.stations_data[name]["failure_breakdowns"] = machine.failure_count
            self.stations_data[name]["pm_breakdowns"] = machine.pm_count
            # Per-sub-machine breakdown — must be captured here, not later:
            # self.resources is rebuilt fresh by _reset_state() at the start
            # of every run()/replication, so this is the only point where
            # this replication's own MachineGroups are still valid.
            self.stations_data[name]["failure_counts_per_machine"] = machine.failure_counts_per_machine
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

    def _release_groups(self) -> Optional[List[Tuple[Dict[str, Any], List[str]]]]:
        """
        Each Start with the products it releases: the ones its own MU table
        lists (a product no Start lists: the first Start). None = no Start
        has an Exit Controller ("MU Strategy") set — every product then
        arrives on its own, as before.
        """
        starts = [s for s in self.stations_data.values() if _station_type(s) == STATION_TYPE_SOURCE]
        if not any(s.get("MU Strategy") for s in starts):
            return None
        claimed: set = set()
        groups: List[Tuple[Dict[str, Any], List[str]]] = []
        for start in starts:
            own: List[str] = []
            for row in start.get("MU Table") or []:
                v = str(row.get("mu", "")) if isinstance(row, dict) else ""
                if v in self.variant_quantities and v not in claimed:
                    own.append(v)
                    claimed.add(v)
            groups.append((start, own))
        rest = [v for v in self.variant_quantities if v not in claimed]
        groups[0] = (groups[0][0], groups[0][1] + rest)
        return groups

    def _release_order(self, start: Dict[str, Any], products: List[str]) -> Optional[List[str]]:
        """
        A Start's Exit Controller ("MU Strategy", set in its panel): the order
        its products are released in, each product as one whole batch. None =
        Percentage (UI only for now) — its products then arrive on their own.
          cyclic    — the MU table's order (tshirt, pant, shirt, ...); also
                      a Start with none set, when another Start has one
          random    — a random order (fixed seed, so runs repeat)
          successor — by "MU Priorities" (1 first); the table's order unless
                      every product has a different priority 1..n
        Products with no quantity (or no route) are left out.
        """
        strategy = str(start.get("MU Strategy") or "cyclic").strip().lower()
        if strategy not in ("cyclic", "random", "successor"):
            return None
        products = [v for v in products if self.variant_quantities.get(v, 0) > 0 and v in self.processflow_data]
        if strategy == "random":
            random.Random(ROUTING_SEED).shuffle(products)
        elif strategy == "successor":
            prios = start.get("MU Priorities") or {}
            values = [prios.get(v) for v in products] if isinstance(prios, dict) else []
            if sorted(p for p in values if isinstance(p, (int, float))) == list(range(1, len(products) + 1)):
                products = [v for _, v in sorted(zip(values, products))]
        return products

    def _release_schedule(self) -> Optional[List[Tuple[str, int, float]]]:
        """
        (product, job number, arrival minute) for every job, when Starts
        release products batch by batch (see _release_order). Every Start
        releases its own products, all Starts from minute 0 at the same time.
        Within a Start each job arrives its own product's Interval after the
        job before it — tshirts every 5 min, then pants every 8 min, ... —
        the very first at 0; no Interval = no gap.
        """
        groups = self._release_groups()
        if groups is None:
            return None
        schedule: List[Tuple[str, int, float]] = []
        batched = False
        for start, products in groups:
            order = self._release_order(start, products)
            if order is None:
                # Percentage (UI only for now): each product arrives on its own.
                for variant in products:
                    gap = float(self.variant_intervals.get(variant, 0) or 0)
                    for i in range(1, self.variant_quantities.get(variant, 0) + 1):
                        schedule.append((variant, i, (i - 1) * gap))
                continue
            batched = True
            t = 0.0
            first = True
            for variant in order:
                gap = float(self.variant_intervals.get(variant, 0) or 0)
                for i in range(1, self.variant_quantities[variant] + 1):
                    if not first:
                        t += gap
                    first = False
                    schedule.append((variant, i, t))
        return schedule if batched else None

    def _delayed_spawn(self, variant_id: int, variant_type: str, delay: float):
        """Wait `delay` minutes (fixed inter-arrival spacing), then start the job."""
        if delay > 0:
            yield self.env.timeout(delay)
        yield from self._process_variant(variant_id, variant_type)

    def _real_stamp(self) -> str:
        """Now as a real date-time, in the completion_log's own format."""
        now_real = self.simulation_state["start_date"] + timedelta(minutes=self.env.now)
        return now_real.strftime("%Y-%m-%d %H:%M:%S")

    def _process_variant(self, variant_id: int, variant_type: str, piece: Optional[Dict[str, Any]] = None):
        # The product whose route this is. variant_type / variant_id are the
        # job's name — after an Assembly with a New FE it goes on as that.
        # A piece from a Dismantle (piece, see _dismantle) goes on along the
        # route that leads to its next station.
        route_type = piece["route"] if piece is not None else variant_type
        steps = self.processflow_data.get(route_type, [])
        # Parts delivered: a job its Start releases now (not a Dismantle piece).
        if piece is None and self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            if variant_type not in self._start_cache:
                self._start_cache[variant_type] = self._start_of(variant_type)
            by_product = self._delivered.setdefault(self._start_cache[variant_type] or "", {})
            by_product[str(variant_type)] = by_product.get(str(variant_type), 0) + 1
        self.simulation_state["job_release_times"].setdefault(_format_job_id(variant_type, variant_id), self._real_stamp())
        # Resolve each step's destination the first time it's needed (either
        # when the loop reaches it, or earlier via the buffer look-ahead one
        # step below) — cached in `resolved` so it's looked up once per job.
        resolved: List[Optional[str]] = [None] * len(steps)

        def resolve(i: int) -> Optional[str]:
            if resolved[i] is None:
                resolved[i] = self._resolve_step_resource(steps[i], route_type)
            return resolved[i]

        # Set by the PREVIOUS step's zero-buffer (Buffer Capacity 0) hand-off:
        # the slot on THIS step's station that the job already queued for and
        # won before leaving the previous station. Consumed by the
        # _perform_operation call below so the job doesn't request twice.
        pending_zero_buffer = None
        # (Buffer name, token): the place this job already holds in the Buffer
        # box that is its NEXT step — won by the previous step's hand-off.
        box_place: Optional[Tuple[str, Any]] = None
        # Route by product: the machines of the next station this job may
        # use, as decided by the hand-off that sent it there (_UNSET: it got
        # there without one, so decide when it arrives).
        handed_allowed: Any = _UNSET
        # A Buffer box with capacity 0 holds nothing, so the job stays where
        # it was (station slot or earlier Buffer place) until the step after
        # that box takes it: (release, in_box) carried across the box's step.
        carried: Optional[Tuple[Callable[[], None], Any]] = None
        # Hand-off channel for a slot _perform_operation kept open (hold_slot).
        self._held_slot = None
        # The stops the job makes, in order: a split (Station 2 / 3 / 4) is
        # one stop where it visits only one of the stations — see
        # _branch_slots / BranchRouter.
        slots = _branch_slots(steps)
        # Step of the NEXT stop (a split) the previous hand-off picked.
        chosen: Optional[int] = None
        # Last station the job was at — its Exit Controller routes a split
        # reached without a hand-off (e.g. after a Connector).
        last_resource: Optional[str] = None
        # Assembly: the place this job (a part, not the main part) already
        # took in the next stop's room — taken by the hand-off before it.
        room_part: Optional[Dict[str, Any]] = None
        # This job's role at each Assembly stop (station, step), decided once
        # — when it is on its way there.
        decided: Dict[Tuple[str, int], Optional[Tuple[str, Optional[str]]]] = {}

        # A Dismantle piece: it starts on the Dismantle station, handed to
        # its own next station like any job leaving a station.
        first_slot = 0
        if piece is not None:
            first_slot, chosen, last_resource = piece["slot"], piece["step"], piece["src"]
            # Dismantle table: the pieces leave in turn (Successor order).
            if piece["after"] is not None:
                yield piece["after"]
            target = resolve(piece["step"])
            role_there = self._decide_assembly_role(target, route_type, piece["step"])
            decided[(target, piece["step"])] = role_there
            if role_there is not None and role_there[0] == "part":
                room_part = yield from self._hand_off_to_room(
                    piece["src"], target, role_there[1], piece["release"], None, variant_type, variant_id)
            else:
                pending_zero_buffer, box_place, carried, _, handed_allowed = yield from self._hand_off_next(
                    piece["src"], target, piece["release"], None, route_type)
            if piece["taken"] is not None:
                piece["taken"].succeed()

        for si, slot in enumerate(slots):
            if si < first_slot:
                continue
            if len(slot) > 1 and chosen is None:
                # A split reached without a hand-off (first step, or right
                # after a Connector): pick and take a free machine now.
                router = self._branch_target(last_resource, steps, slot, resolve)
                if router is None:
                    idx = slot[0]
                else:
                    pending_zero_buffer, _, _, idx = yield from self._hand_off_branch(
                        None, router, lambda: None, None,
                        self._route_allowed(last_resource, route_type, router, take_turn=True))
            elif len(slot) > 1:
                idx = chosen
            else:
                idx = slot[0]
            chosen = None
            step = steps[idx]
            resource_name = resolve(idx)
            # Route by product on the station before: the machines of this
            # station (one with several machines) this job may use.
            if handed_allowed is not _UNSET:
                allowed_here = handed_allowed
            elif len(slot) == 1 and resource_name is not None:
                allowed_here = self._route_allowed(last_resource, route_type, resource_name, take_turn=True)
            else:
                allowed_here = None
            handed_allowed = _UNSET
            if resource_name is not None:
                last_resource = resource_name
            if resource_name is None:
                logger.warning(
                    "Resource for step '%s' not found in stations_data — skipping for %s#%s",
                    step.get("operation"), variant_type, variant_id,
                )
                continue
            durations = step.get("durations")
            preacquired = pending_zero_buffer
            pending_zero_buffer = None
            # Where the job goes next: a station name, or a BranchRouter when
            # the next stop is a split.
            nxt: Any = None
            if si + 1 < len(slots):
                next_slot = slots[si + 1]
                if len(next_slot) > 1:
                    nxt = self._branch_target(resource_name, steps, next_slot, resolve)
                if nxt is None:
                    nxt = resolve(next_slot[0])
            station_cfg = self.stations_data[resource_name]
            # Assembly: this job's role here (the main part, or a part), and
            # whether its next stop is an Assembly that takes it as a part —
            # then it goes into that Assembly's room instead of onto its machine.
            if (resource_name, idx) not in decided:
                decided[(resource_name, idx)] = self._decide_assembly_role(resource_name, route_type, idx)
            role = decided[(resource_name, idx)]
            next_role = None
            if isinstance(nxt, str) and si + 1 < len(slots):
                next_key = (nxt, slots[si + 1][0])
                if next_key not in decided:
                    decided[next_key] = self._decide_assembly_role(nxt, route_type, slots[si + 1][0])
                next_role = decided[next_key]
            into_room = next_role is not None and next_role[0] == "part"

            # --- Assembly, as a part: never takes the machine — waits in the
            # room until a main part takes it in; its route ends here.
            if role is not None and role[0] == "part":
                if preacquired is not None:
                    preacquired[0].__exit__(None, None, None)
                part = room_part
                room_part = None
                if part is None:
                    # Reached without a hand-off (straight from Start, or
                    # through a junction / a Buffer that holds nothing).
                    release, in_box = carried if carried is not None else ((lambda: None), None)
                    carried = None
                    part = yield from self._hand_off_to_room(
                        None, resource_name, role[1], release, in_box, variant_type, variant_id)
                yield part["done"]
                self.simulation_state["in_progress_jobs"] = max(0, self.simulation_state["in_progress_jobs"] - 1)
                return

            # --- Buffer box: holds the job, takes no time.
            if _is_buffer(station_cfg):
                if preacquired is not None:
                    preacquired[0].__exit__(None, None, None)
                box = self.buffer_boxes[resource_name]
                if box_place is None and carried is None and not box.passes_through:
                    # Reached without a hand-off (e.g. straight from Start or
                    # a Connector): take a place now.
                    token = object()
                    yield from box.enter(token)
                    box_place = (resource_name, token)
                trace_start = self.env.now
                trace = self._log_passthrough(resource_name, variant_id, variant_type, step.get("operation", ""))
                if box_place is not None:
                    in_box = (box, box_place[1])
                    release = (lambda b=box, t=box_place[1]: b.leave(t))
                elif carried is not None:
                    release, in_box = carried
                else:
                    release, in_box = (lambda: None), None
                box_place, carried = None, None
                if nxt is None and step.get("holds_parts"):
                    # Last box of a line with no End: the part stays in the
                    # buffer for the rest of the run (it can fill up and block
                    # the station before it) and counts as finished below.
                    self._hold_in_last_buffer(trace)
                    continue
                if nxt is None:
                    release()
                elif into_room:
                    room_part = yield from self._hand_off_to_room(
                        resource_name, nxt, next_role[1], release, in_box, variant_type, variant_id)
                else:
                    pending_zero_buffer, box_place, carried, chosen, handed_allowed = yield from self._hand_off_next(
                        resource_name, nxt, release, in_box, route_type)
                self._close_passthrough(trace, trace_start)
                continue

            # A Connector is a routing junction, not a work station: the job
            # passes straight through with no delay, no machine contention and
            # no operator. Handled here rather than inside _perform_operation
            # so none of that function's machine machinery (capacity request,
            # setup, downtime, rework, busy_time accounting) runs at all. The
            # job still gets a trace entry so it doesn't look like a dropped
            # step in the Job Trace.
            if _is_passthrough(station_cfg):
                # Nothing is processed here, so a zero-buffer slot won for this
                # step would otherwise be held for the rest of the run.
                if preacquired is not None:
                    preacquired[0].__exit__(None, None, None)
                self._log_passthrough(resource_name, variant_id, variant_type, step.get("operation", ""))
                continue

            # The finished job stays on this station (keeps its slot) until
            # the next step takes it — unless that is a station with an
            # unlimited queue or a zero-time junction, which always take it
            # at once. Decided before processing so _perform_operation keeps
            # the slot instead of releasing it on the way out.
            hold_slot = False
            if into_room:
                # Into an Assembly's room: held here until there is a place.
                hold_slot = True
            elif isinstance(nxt, BranchRouter):
                # A split only takes the job onto a free machine.
                hold_slot = True
            elif nxt is not None:
                nxt_station = self.stations_data[nxt]
                if _is_buffer(nxt_station):
                    hold_slot = True
                elif not _is_passthrough(nxt_station) and not nxt_station.get("Buffer Unlimited", False):
                    hold_slot = True

            # Dismantle: the job stays on the machine until every piece has
            # been taken by its next station.
            if resource_name in self._dismantle_exits:
                hold_slot = True

            # Assembly, as the main part: it waits on the machine for its parts.
            join = None
            if role is not None and role[0] == "main":
                join = (lambda entry, st=resource_name, t=variant_type, i=variant_id: self._join_parts(st, t, i, entry))

            outcome = None
            try:
                if isinstance(durations, list):
                    for i, duration in enumerate(durations):
                        outcome = yield from self._perform_operation(
                            resource_name, variant_id, variant_type,
                            step["operation"],
                            station_cfg.get("operator_per_station", 1),
                            station_cfg.get("shifts_per_day", 1),
                            duration,
                            preacquired=preacquired if i == 0 else None,
                            hold_slot=hold_slot and i == len(durations) - 1,
                            allowed_machines=allowed_here if i == 0 else None,
                            assembly_join=join if i == 0 else None,
                        )
                        if outcome in ("rejected", "in_progress", "scrapped"):
                            break
                else:
                    outcome = yield from self._perform_operation(
                        resource_name, variant_id, variant_type,
                        step["operation"],
                        station_cfg.get("operator_per_station", 1),
                        station_cfg.get("shifts_per_day", 1),
                        step["duration"],
                        preacquired=preacquired,
                        hold_slot=hold_slot,
                        allowed_machines=allowed_here,
                        assembly_join=join,
                    )
            except Exception as exc:
                logger.error(
                    "%s#%s at station '%s' op '%s': %s",
                    variant_type, variant_id, resource_name, step.get("operation"), exc,
                    exc_info=True,
                )
                # Continue to next step so job can still complete
                continue

            # Slot this station is still holding because the job is finished
            # but has nowhere to go yet (hold_slot above). Released only once
            # the next step has actually taken the job.
            held_slot = self._held_slot
            self._held_slot = None

            # Assembly: the room's places this assembly took open once it has
            # left the machine — now if the machine is already free, else
            # when the slot is let go.
            leave_room = (lambda: None)
            if join is not None:
                leave_room = (lambda st=resource_name, m=_format_job_id(variant_type, variant_id):
                              self._assembly_room(st).release(m))
                if held_slot is None:
                    leave_room()
                    leave_room = (lambda: None)

            # A Worker Controller rejected this job outright (Queue Policy =
            # reject, queue full), the simulation horizon ran out mid-step
            # (its trace_entry is already "In Progress" with partial credit),
            # or FailurePolicy.SCRAP discarded the part — the job leaves the
            # line here: it must NOT continue or be counted as completed.
            if outcome in ("rejected", "in_progress", "scrapped"):
                if held_slot is not None:
                    held_slot.__exit__(None, None, None)
                leave_room()
                return

            # Assembled with a New FE: the job goes on as that (Car-001, ...);
            # or as its renumbered Main FE (a-A001, ...).
            if join is not None:
                out = self._assembly_out.pop(_format_job_id(variant_type, variant_id), None)
                if out is not None:
                    variant_type, variant_id = out
                    self.simulation_state["job_release_times"][_format_job_id(*out)] = self._real_stamp()

            # Dismantle (FEs to all Successors): the job splits into one piece
            # per next station; the pieces go on, the job itself ends here.
            if resource_name in self._dismantle_exits:
                self._dismantle(resource_name, variant_type, variant_id, held_slot,
                                piece["of"] if piece is not None else None)
                return

            if nxt is not None:
                release = ((lambda s=held_slot, f=leave_room: (s.__exit__(None, None, None), f()))
                           if held_slot is not None else (lambda: None))
                held_slot = None
                if into_room:
                    room_part = yield from self._hand_off_to_room(
                        resource_name, nxt, next_role[1], release, None, variant_type, variant_id)
                else:
                    pending_zero_buffer, box_place, carried, chosen, handed_allowed = yield from self._hand_off_next(
                        resource_name, nxt, release, None, route_type)

            # Last step: nothing after it, so free the slot now.
            if held_slot is not None:
                held_slot.__exit__(None, None, None)
                held_slot = None
                leave_room()

        self.simulation_state["total_simulated_time"] = self.env.now
        self.simulation_state["job_finish_times"][_format_job_id(variant_type, variant_id)] = self._real_stamp()
        # Parts collected: it has left its last station for the End (each
        # Dismantle piece too), by that station and its name.
        if self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            name = getattr(variant_type, "base", None) or str(variant_type)
            by_name = self._collected.setdefault(last_resource or "", {}).setdefault(str(route_type), {})
            by_name[name] = by_name.get(name, 0) + 1
        if piece is not None:
            # A Dismantle piece: its job counts once, when its last piece is done.
            self._piece_done(piece["of"])
        # Excluded from the headline "Completed Jobs" KPI during warm-up, same
        # as the per-station counters above — see _validate_config.
        elif self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            self.simulation_state["completed_jobs"] += 1
        self.simulation_state["in_progress_jobs"] = max(
            0, self.simulation_state["in_progress_jobs"] - 1
        )
        self.simulation_state["job_count"] = self.simulation_state["completed_jobs"]

    def _find_dismantle_exits(self) -> None:
        """
        Before the run: each Dismantle station's next stations — every line
        leaving it, of any product's route, in the order the routes list
        them. For each: (next station, the product whose route leads there,
        its stop and step there); a piece goes on along that route. Then
        what each dismantled job makes (_dismantle_plan), by its Sequence:
          FEs to all Successors — 1 piece per next station, all at once.
          Dismantle input configuration — the Dismantle table: per row,
            Number pieces named FE to its station; the rows leave in
            Successor (priority) order, each piece once the one before it
            has been taken. Raises ValueError for a table that can't work.
        A Dismantle without its panel settings saved, or with no next
        station, works as a plain station.
        """
        self._dismantle_exits: Dict[str, List[Tuple[str, str, int, int]]] = {}
        # Station -> (each piece's exit, in leaving order; whether each waits
        # for the one before it).
        self._dismantle_plan: Dict[str, Tuple[List[Tuple[str, str, int, int]], bool]] = {}
        for name, cfg in self.stations_data.items():
            settings = cfg.get("Dismantle")
            if _station_type(cfg) != "Dismantle" or not isinstance(settings, dict):
                continue
            sequence = settings.get("sequence") or "all_successors"
            if sequence not in ("all_successors", "input_config"):
                continue
            exits: List[Tuple[str, str, int, int]] = []
            for product, steps in self.processflow_data.items():
                slots = _branch_slots(steps)
                for si in range(len(slots) - 1):
                    if not any(self._resolve_step_resource(steps[i], product) == name for i in slots[si]):
                        continue
                    for idx in slots[si + 1]:
                        nxt = self._resolve_step_resource(steps[idx], product)
                        if nxt is not None and nxt not in [e[0] for e in exits]:
                            exits.append((nxt, product, si + 1, idx))
            if not exits:
                continue
            # Lines numbered in the order they were connected on the Canvas
            # (saved as "successors"); a station not listed goes last.
            order = [str(s) for s in settings.get("successors") or []]

            def line_of(e: Tuple[str, str, int, int]) -> int:
                group = self.stations_data.get(e[0], {}).get("Parallel Group")
                return next((i for i, s in enumerate(order) if s in (e[0], group)), len(order))
            exits.sort(key=line_of)
            self._dismantle_exits[name] = exits
            if sequence == "all_successors" and self._dismantle_main_line(settings) is not None:
                main_line = settings.get("mainFeToSuccessor")
                if not isinstance(main_line, int) or isinstance(main_line, bool) or not 1 <= main_line <= len(exits):
                    raise ValueError(f"{name}: Main FE to Successor is {main_line}, but only {len(exits)} "
                                     f"line{'' if len(exits) == 1 else 's'} go out.")
            if sequence == "all_successors":
                self._dismantle_plan[name] = (list(exits), False)
            else:
                self._dismantle_plan[name] = (self._dismantle_table_pieces(name, settings, exits), True)

    def _dismantle_table_pieces(
        self, name: str, settings: Dict[str, Any], exits: List[Tuple[str, str, int, int]],
    ) -> List[Tuple[str, str, int, int]]:
        """The pieces a Dismantle table makes, in leaving order (Successor,
        then row order). Raises ValueError for a row that can't work."""
        def fail(msg: str) -> None:
            raise ValueError(f"{name}: {msg}")

        rows = [r for r in settings.get("table") or [] if isinstance(r, dict)]
        if not rows:
            fail("fill in the Dismantle table (Sequence is Dismantle input configuration).")
        ordered = []
        for i, row in enumerate(rows):
            to = str(row.get("to") or "")
            number, successor = row.get("number"), row.get("successor")
            if not isinstance(number, int) or isinstance(number, bool) or number < 1:
                fail(f"Number for {to} must be a whole number, 1 or more.")
            if not isinstance(successor, int) or isinstance(successor, bool) or not 1 <= successor <= len(rows):
                fail(f"Successor for {to} must be from 1 to {len(rows)}.")
            # The row's station: the next station itself, or (a parallel
            # group's name) one of its machines.
            exit_ = next((e for e in exits if e[0] == to
                          or self.stations_data.get(e[0], {}).get("Parallel Group") == to), None)
            if exit_ is None:
                fail(f"no route goes from it to {to} — draw that line for a product, or remove the row.")
            ordered.append((successor, i, exit_, number))
        ordered.sort(key=lambda r: (r[0], r[1]))
        return [exit_ for _, _, exit_, number in ordered for _ in range(number)]

    @staticmethod
    def _dismantle_main_line(settings: Dict[str, Any]) -> Optional[int]:
        """FEs to all Successors + Create FE + New FE: the line (Main FE to
        Successor, 1 = the first connected) whose piece keeps the part's name
        — the other lines get the New FE name. None otherwise."""
        if ((settings.get("sequence") or "all_successors") == "all_successors"
                and settings.get("mode") != "detach_fe" and settings.get("exitingFe") == "new_fe"):
            return settings.get("mainFeToSuccessor")
        return None

    def _dismantle(self, station: str, variant_type: str, variant_id: int,
                   held_slot: Any, parent: Optional[Dict[str, Any]]) -> None:
        """
        The job finished at Dismantle `station`: its pieces, as planned
        (_dismantle_plan). Exiting FE names them (Create FE and Detach FE
        alike, for now):
          Main FE — every piece keeps the job's name: Car-001, Car-001-2, ...
          New FE  — every piece gets the New FE name, numbered of its own:
                    Body-001, Body-002, ...; no name given: "<name> A"
                    (Car A-001, ...).
        The same for both Sequences.
        FEs to all Successors + Create FE + New FE: the line Main FE to
        Successor names keeps the part's name, the others get the New FE name.
        Each piece is handed to its next station (in turn, for a Dismantle
        table); the Dismantle machine (held_slot) is free once all of them
        have been taken. The job counts once, when its last piece is done
        (see _piece_done).
        """
        plan, in_turn = self._dismantle_plan[station]
        settings = self.stations_data[station]["Dismantle"]
        new_fe = settings.get("exitingFe") == "new_fe"
        create = settings.get("mode") != "detach_fe"
        job = _format_job_id(variant_type, variant_id)
        base = getattr(variant_type, "base", None) or str(variant_type)

        waiting = {"n": len(plan)}

        def release_one() -> None:
            waiting["n"] -= 1
            if waiting["n"] == 0 and held_slot is not None:
                held_slot.__exit__(None, None, None)

        group = {"left": len(plan), "job": job, "parent": parent}
        pieces: List[str] = []
        own = 0          # pieces so far named as the job (Detach FE)
        before = None    # the piece before this one has been taken
        main_line = self._dismantle_main_line(settings)
        for line, (nxt, product, slot, step) in enumerate(plan, start=1):
            if new_fe and line == main_line:
                name = base
            elif new_fe:
                name = str(settings.get("newFeName") or "").strip() or f"{base} A"
            else:
                name = base
            if name == base:
                # Internal number only (the job id is the piece's own), kept
                # clear of the product's real numbers.
                self._piece_seq += 1
                piece_no = 1_000_000 + self._piece_seq
                own += 1
                piece_id = job if own == 1 else f"{job}-{own}"
            else:
                while True:
                    self._piece_counts[name] = self._piece_counts.get(name, 0) + 1
                    piece_no = self._piece_counts[name]
                    piece_id = f"{name}-{piece_no:03d}"
                    if piece_id not in self.simulation_state["job_release_times"]:
                        break
            pieces.append(piece_id)
            taken = self.env.event() if in_turn else None
            self.env.process(self._process_variant(
                piece_no, _PieceType(name, piece_id),
                piece={"route": product, "slot": slot, "step": step, "src": station,
                       "release": release_one, "of": group, "after": before, "taken": taken}))
            before = taken
        # Each piece is a job in progress of its own until it is done.
        self.simulation_state["in_progress_jobs"] += len(plan) - 1
        if self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            cfg = self.stations_data[station]
            cfg["output_components"] = cfg.get("output_components", 0) + len(plan)
        self.simulation_state["dismantles"][job] = {
            "station": station, "mode": "create" if create else "detach", "pieces": pieces}

    def _piece_done(self, group: Dict[str, Any]) -> None:
        """A Dismantle piece finished its route. The last piece of a job
        completes that job (counted once) — or, for a piece of a piece, the
        piece it came from."""
        group["left"] -= 1
        if group["left"] > 0:
            return
        if group["parent"] is not None:
            self._piece_done(group["parent"])
        elif self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            self.simulation_state["completed_jobs"] += 1

    def _route_choices(self, nxt: Any) -> List[str]:
        """The next boxes a job leaving for `nxt` can be sent to, as named on
        the Canvas: a split's choices (BranchRouter), or "Station #1",
        "Station #2", ... for one station with several machines. Fewer than
        two = nothing to choose."""
        if isinstance(nxt, BranchRouter):
            return nxt.labels()
        if isinstance(nxt, str) and nxt in self.resources:
            n = len(self.resources[nxt].sub_machines)
            if n > 1 and not _is_conveyor(self.stations_data[nxt]) and not _is_passthrough(self.stations_data[nxt]):
                return [f"{nxt} #{m + 1}" for m in range(n)]
        return []

    def _route_allowed(
        self, src: Optional[str], variant: str, nxt: Any, take_turn: bool = False,
    ) -> Optional[set]:
        """
        Route by product on station `src`: which of the next boxes (indexes
        into _route_choices) a job of `variant` may go to — its ticked ones;
        src's Exit Controller then picks among them. None = no restriction
        (not switched on, or nothing to choose between).

        Route based is always Cyclic (whatever Exit Strategy was saved with
        it): the order is strict and each product keeps its own — its 1st job
        goes to its 1st ticked box, the 2nd to the next, ... (#1, #2, #1, #2
        ...), and a job waits for the box whose turn it is — busy or not, it
        never skips to another. So one box is returned, and take_turn=True
        (once per job, when it is ready to leave src) moves that product's
        turn on.
        """
        cfg = self.stations_data.get(src) if src is not None else None
        if not cfg or not cfg.get("Route By Product"):
            return None
        choices = self._route_choices(nxt)
        if len(choices) < 2:
            return None
        routes = cfg.get("Product Routes") or {}
        ticked = {str(x).strip() for x in (routes.get(variant) or [])} if isinstance(routes, dict) else set()
        allowed = {k for k, label in enumerate(choices) if label.strip() in ticked}
        if not allowed:
            raise ValueError(f"{src}: Route based — no station is ticked for {variant}")
        if not take_turn:
            return allowed
        order = sorted(allowed)
        key = (src, tuple(choices), variant)
        turn = self.product_turns.get(key, 0)
        self.product_turns[key] = turn + 1
        return {order[turn % len(order)]}

    def _check_route_by_product(self) -> None:
        """Before the run: every product leaving a station with Route by
        product switched on has at least one station ticked — else the run
        stops here, naming the station and the product."""
        for variant, steps in self.processflow_data.items():
            if self.variant_quantities.get(variant, 0) <= 0:
                continue
            slots = _branch_slots(steps)
            names = [self._resolve_step_resource(s, variant) for s in steps]
            for prev_slot, next_slot in zip(slots, slots[1:]):
                if len(prev_slot) != 1:
                    continue
                src = names[prev_slot[0]]
                if src is None:
                    continue
                if len(next_slot) > 1:
                    nxt = self._branch_target(src, steps, next_slot, lambda i: names[i])
                    if nxt is None:
                        nxt = names[next_slot[0]]
                else:
                    nxt = names[next_slot[0]]
                if nxt is not None:
                    self._route_allowed(src, variant, nxt)

    def _run_over(self) -> bool:
        """
        No usable time left before SIM_TIME. Work is cut 1e-6 before the end
        (SimPy never fires an event AT SIM_TIME), and float rounding can leave
        a hair over 1e-6 — so 2e-6, or the next chunk is too small to move the
        clock and the job loops forever.
        """
        return self.sim_config["SIM_TIME"] - self.env.now <= 2e-6

    def _check_conveyor_sensors(self) -> None:
        """Before the run: a conveyor's sensor must sit on the belt (0 to
        Conveyor Length) — else the run stops here, naming the conveyor."""
        for name, station in self.stations_data.items():
            if not _is_conveyor(station) or station.get("Conveyor Sensor Length") in (None, ""):
                continue
            length = _positive_float(station.get("Conveyor Length"))
            try:
                sensor = float(station.get("Conveyor Sensor Length"))
            except (TypeError, ValueError):
                raise ValueError(f"{name}: sensor length must be a number")
            if length is not None and not 0 <= sensor <= length:
                raise ValueError(
                    f"{name}: sensor ({sensor:g} m) is longer than the conveyor ({length:g} m)"
                    if sensor > length else f"{name}: sensor length can't be below 0 m")

    def _start_of(self, variant: str) -> Optional[str]:
        """The Start that releases a product: the one whose MU table lists it
        (none does: the first Start)."""
        starts = [(n, s) for n, s in self.stations_data.items() if _station_type(s) == STATION_TYPE_SOURCE]
        for name, start in starts:
            if any(isinstance(r, dict) and str(r.get("mu", "")) == variant for r in start.get("MU Table") or []):
                return name
        return starts[0][0] if starts else None

    def _line_into(self, variant: str, steps: List[Dict[str, Any]], slots: List[List[int]], si: int) -> Optional[str]:
        """The line a product comes into stop `si` on: the station of the stop
        before (its parallel group, for a machine of one) — or, for its first
        stop, the Start that releases it. Matches the Canvas's line names."""
        if si == 0:
            return self._start_of(variant)
        prev = self._resolve_step_resource(steps[slots[si - 1][0]], variant)
        if prev is None:
            return None
        return str(self.stations_data[prev].get("Parallel Group") or prev)

    def _assembly_spec(self, name: str, cfg: Dict[str, Any], arrivals: List[Optional[str]]) -> Optional[Dict[str, Any]]:
        """
        An Assembly station's settings (its Assembly panel), checked: which
        line brings the main part, and the parts one assembly needs besides
        it (key -> amount). Raises ValueError for settings that can't work —
        the same checks the Canvas makes before Save.
          None         — Main FE from predecessor is the main line, counted
                         in the order connected (1 = P1); 1 part from
                         every other line.
          Predecessors — Main FE from predecessor is the main line's No.; the
                         other lines' amounts.
          Flow Entity  — Main FE from predecessor is the main line, counted
                         in the order connected (as None); the
                         FE table's products and amounts, from any line.
        """
        def fail(msg: str) -> None:
            raise ValueError(f"{name}: {msg}")

        table = str(cfg.get("table") or "none")
        mode = "attach" if cfg.get("mode") == "attach_mus" else "delete"
        new_fe = cfg.get("exitingMu") == "new_fe"
        new_name = str(cfg.get("newFeName") or "").strip()
        raw_lines = cfg.get("lines")
        if isinstance(raw_lines, list) and raw_lines:
            lines = [(str(l.get("from")), int(l.get("no") or i + 1), int(l.get("amount") or 1))
                     for i, l in enumerate(raw_lines) if isinstance(l, dict)]
        else:
            # Saved before the lines were: the lines its products come in on.
            lines = [(f, i + 1, 1) for i, f in enumerate(dict.fromkeys(a for a in arrivals if a))]
        if not lines:
            return None
        default_main = cfg.get("mainMuDefault", cfg.get("mainMuFromPredecessor", 1) == 1)
        main_value = 1 if default_main else int(cfg.get("mainMuFromPredecessor") or 1)

        if new_fe and mode == "delete":
            fail("Delete entity keeps only the main part — a New FE needs Attach all parts (or choose Main FE).")
        if new_fe and not new_name:
            fail("give the New FE a name.")
        if len(lines) == 2 and mode == "attach" and not new_fe:
            fail("with 2 lines, Attach all parts needs a New FE — or choose Delete entity.")

        if table != "predecessors":
            if not 1 <= main_value <= len(lines):
                fail(f"Main FE from predecessor is {main_value}, but only {len(lines)} lines come in.")
            # Lines are saved in the order they were connected (P1 first).
            main = lines[main_value - 1]
        if table == "none":
            needs = {f"line:{f}": 1 for f, _, _ in lines if f != main[0]}
        else:
            if table == "predecessors":
                main = next((l for l in lines if l[1] == main_value), None)
                if main is None:
                    fail(f"no line has No. {main_value} — the main part (Main FE from predecessor).")
            if table == "mu_types":
                needs: Dict[str, int] = {}
                for row in cfg.get("muTypeRows") or []:
                    mu = str((row or {}).get("mu") or "").strip()
                    amount = int((row or {}).get("amount") or 0)
                    if not mu:
                        fail("choose an FE for every row of the FE table.")
                    if amount < 1:
                        fail("every FE amount must be 1 or more.")
                    needs[f"fe:{mu}"] = needs.get(f"fe:{mu}", 0) + amount
            else:
                needs = {f"line:{f}": max(1, amount) for f, _, amount in lines if f != main[0]}
                # More than 1 from the main line: the first sits on the
                # machine, the others wait in the room like any other part.
                if main[2] > 1:
                    needs[f"line:{main[0]}"] = main[2] - 1
        main_amount = main[2] if table == "predecessors" else 1
        return {"type": table, "main_from": main[0], "main_amount": max(1, main_amount), "needs": needs,
                "mode": mode, "new_fe": new_name if new_fe else None}

    def _check_assemblies(self) -> None:
        """
        Before the run: every Assembly set up in its panel, checked; the role
        each product has at it (the main part, or which part) — a product
        coming in on a line the Assembly doesn't take stops the run here.
        Also warns (without stopping) when the quantities can't all be used:
        e.g. wheels for only 30 cars but 200 bodies.
        """
        self.assembly_specs: Dict[str, Dict[str, Any]] = {}
        self._assembly_roles: Dict[Tuple[str, str, int], Tuple[str, Optional[str]]] = {}
        configured = {
            name: st["Assembly"] for name, st in self.stations_data.items()
            if _station_type(st) == "Assembly" and isinstance(st.get("Assembly"), dict)
        }
        if not configured:
            return
        arrivals: Dict[str, List[Tuple[str, int, Optional[str]]]] = {name: [] for name in configured}
        for variant, steps in self.processflow_data.items():
            if self.variant_quantities.get(variant, 0) <= 0:
                continue
            slots = _branch_slots(steps)
            for si, slot in enumerate(slots):
                for idx in slot:
                    res = self._resolve_step_resource(steps[idx], variant)
                    if res in configured:
                        arrivals[res].append((variant, idx, self._line_into(variant, steps, slots, si)))

        for name, cfg in configured.items():
            spec = self._assembly_spec(name, cfg, [f for _, _, f in arrivals[name]])
            if spec is None:
                continue
            self.assembly_specs[name] = spec
            main_supply = 0
            supply: Dict[str, int] = {}
            for variant, idx, line in arrivals[name]:
                qty = self.variant_quantities.get(variant, 0)
                if line == spec["main_from"]:
                    role: Tuple[str, Optional[str]] = ("main", None)
                    main_supply += qty
                else:
                    key = f"fe:{variant}" if spec["type"] == "mu_types" else f"line:{line}"
                    if key not in spec["needs"]:
                        if spec["type"] == "mu_types":
                            raise ValueError(f"{name}: {variant} comes in from {line}, but it isn't in the FE table.")
                        raise ValueError(f"{name}: {variant} comes in from {line}, which isn't one of its lines "
                                         f"— open the Assembly on the Canvas and save again.")
                    role = ("part", key)
                    supply[key] = supply.get(key, 0) + qty
                self._assembly_roles[(name, variant, idx)] = role

            # Quantities that can't all be used: a warning, not a stop. The
            # main line's parts (main_amount per assembly) all come from
            # main_supply.
            main_key = f"line:{spec['main_from']}"
            others = {k: n for k, n in spec["needs"].items() if k != main_key}
            possible = main_supply // spec["main_amount"]
            for key, need in others.items():
                possible = min(possible, supply.get(key, 0) // need)
            left = []
            if main_supply > possible * spec["main_amount"]:
                left.append(f"{main_supply - possible * spec['main_amount']} main parts")
            for key, need in others.items():
                extra = supply.get(key, 0) - possible * need
                if extra > 0:
                    left.append(f"{extra} × {key.split(':', 1)[1]}")
            if left:
                self.simulation_state["warnings"].append(
                    f"{name}: parts for only {possible} assemblies — {', '.join(left)} can never be used.")

    def _decide_assembly_role(self, station: str, route_type: str, idx: int) -> Optional[Tuple[str, Optional[str]]]:
        """
        This job's role at an Assembly (None: not an Assembly). A main-line
        job is the main part — unless the Assembly takes more than 1 from the
        main line: then, in the order they come, 1 in every main_amount is
        the main part (sits on the machine) and the rest are parts (wait in
        the room). Decided once per job, when it is on its way there.
        """
        role = self._assembly_roles.get((station, route_type, idx))
        if role is None or role[0] != "main":
            return role
        spec = self.assembly_specs[station]
        if spec["main_amount"] <= 1:
            return role
        turn = self._main_turns.get(station, 0)
        self._main_turns[station] = turn + 1
        return role if turn % spec["main_amount"] == 0 else ("part", f"line:{spec['main_from']}")

    def _assembly_room(self, station: str) -> AssemblyRoom:
        room = self.assembly_rooms.get(station)
        if room is None:
            room = self.assembly_rooms[station] = AssemblyRoom(self.env, self.assembly_specs[station]["needs"])
        return room

    def _enter_room(self, station: str, key: str, job_type: str, job_id: int) -> Dict[str, Any]:
        """A part goes into an Assembly's room: it shows there as waiting
        until a main part takes it in."""
        entry = {
            "job_id": _format_job_id(job_type, job_id),
            "station_name": station,
            "status": "Waiting",
            "process_start_time_real": self._real_stamp(),
            "process_end_time_real": None,
            "delay_reason": "Waiting at the Assembly for its main part",
        }
        self.completion_log.setdefault(station, []).append(entry)
        part = {"id": entry["job_id"], "entry": entry, "done": self.env.event()}
        self._assembly_room(station).put(key, part)
        return part

    def _hand_off_to_room(
        self, src: Optional[str], station: str, key: str, release_src: Callable[[], None],
        in_box: Optional[Tuple["BufferBox", Any]], job_type: str, job_id: int,
    ):
        """Wait until the Assembly's room has a place for this kind of part
        (the job stays where it is meanwhile — its station blocked), move in,
        then release where it was. Returns the part (see _enter_room)."""
        room = self._assembly_room(station)
        box, token = in_box if in_box is not None else (None, None)
        block_start = self.env.now
        while not ((box is None or box.may_leave(token)) and room.has_room(key)):
            waits = [room.changed()]
            if box is not None:
                waits.append(box.changed())
            yield self.env.any_of(waits)
        part = self._enter_room(station, key, job_type, job_id)
        if src is not None:
            self._add_buffer_block(src, block_start)
        release_src()
        return part

    def _join_parts(self, station: str, main_type: str, main_id: int, trace_entry: Dict[str, Any]):
        """
        The main part, on the Assembly machine: wait until every part one
        assembly needs is in the room, then take them in — used up (Delete
        entity) or attached (Attach all parts). With a New FE the main part
        leaves as the next new product (Car-001, ...). Returns the minutes
        it waited.
        """
        room = self._assembly_room(station)
        spec = self.assembly_specs[station]
        start = self.env.now
        if not room.complete():
            trace_entry["delay_reason"] = "Waiting for parts"
        while not room.complete():
            yield room.changed()
        main_job = _format_job_id(main_type, main_id)
        parts = room.take(main_job)
        waited = self.env.now - start
        cfg = self.stations_data[station]
        cfg["parts_wait_time"] = cfg.get("parts_wait_time", 0) + waited

        out_job = main_job
        if spec["new_fe"]:
            counts = self.simulation_state.setdefault("new_fe_counts", {})
            counts[spec["new_fe"]] = counts.get(spec["new_fe"], 0) + 1
            out = (spec["new_fe"], counts[spec["new_fe"]])
            self._assembly_out[main_job] = out
            out_job = _format_job_id(*out)
        elif spec["main_amount"] > 1:
            # Main FE from more than 1 main-line job: renumbered 1, 2, 3, ...
            # (a-A001) — the jobs in between went in as parts.
            counts = self._main_fe_counts
            counts[main_type] = counts.get(main_type, 0) + 1
            out = (_AssembledType(main_type), counts[main_type])
            self._assembly_out[main_job] = out
            out_job = _format_job_id(*out)
        stamp = self._real_stamp()
        for part in parts:
            part["entry"].update({
                "status": "Assembled",
                "process_end_time_real": stamp,
                "delay_reason": (f"Attached to {out_job}" if spec["mode"] == "attach"
                                 else f"Used in {out_job} (Delete entity)"),
            })
            part["done"].succeed()
        self.simulation_state["assembled_parts"] += len(parts)
        self.simulation_state["assemblies"][out_job] = {
            "station": station, "main": main_job, "mode": spec["mode"], "parts": [p["id"] for p in parts],
        }
        return waited

    def _hand_off_next(
        self,
        src: str,
        nxt: Any,
        release_src: Callable[[], None],
        in_box: Optional[Tuple["BufferBox", Any]],
        variant: str = "",
    ):
        """
        _hand_off for whatever comes next: a station name, or a BranchRouter
        (a split). Returns _hand_off's three values, the split's step index
        the job was sent to (None when nxt is a plain station), and the
        machines of nxt it may use (Route by product — taken here once, so
        the next station's own request uses the same turn).
        """
        allowed = self._route_allowed(src, variant, nxt, take_turn=True)
        if isinstance(nxt, BranchRouter):
            pending, box_place, carried, chosen = yield from self._hand_off_branch(src, nxt, release_src, in_box, allowed)
            return pending, box_place, carried, chosen, None
        pending, box_place, carried = yield from self._hand_off(src, nxt, release_src, in_box, allowed)
        return pending, box_place, carried, None, allowed

    def _hand_off_branch(
        self,
        src: Optional[str],
        router: BranchRouter,
        release_src: Callable[[], None],
        in_box: Optional[Tuple["BufferBox", Any]],
        allowed: Optional[set] = None,
    ):
        """
        Hand the job from `src` (None: reached without a station to leave)
        into a split. It waits — still on src, which stays blocked — until
        one of the split's machines is free, then the router (src's Exit
        Controller) picks one and the job goes straight onto it. Returns
        (that machine's slot, None, None, the chosen step index).

        A parallel group (router.line set): while every machine is busy the
        job moves into the group's shared line, as soon as it has room —
        src is freed then — and the first in line goes to the next machine
        that frees up. The slot then also carries when the job joined the
        line, so its wait there counts at the machine it gets.

        `allowed` (Route by product): the choices this job may take. Only the
        first in the shared line picks, so one waiting for its own machine
        holds the line even if a job behind it could take another.
        """
        box, token = in_box if in_box is not None else (None, None)
        line = router.line
        me = object()
        joined_at: Optional[float] = None
        block_start = self.env.now
        while True:
            box_turn = box is None or box.may_leave(token)
            if joined_at is not None:
                may_pick = line.head() is me
            else:
                may_pick = box_turn and (line is None or not line.jobs)
            if may_pick:
                pick = router.pick(allowed)
                if pick is not None:
                    break
            if joined_at is None and line is not None and box_turn and line.has_room():
                # Every machine busy: wait in the shared line, not on src.
                line.join(me)
                joined_at = self.env.now
                if src is not None:
                    self._add_buffer_block(src, block_start)
                release_src()
                continue
            waits = [group.freed() for group in router.groups]
            if line is not None:
                waits.append(line.changed())
            if box is not None and joined_at is None:
                waits.append(box.changed())
            yield self.env.any_of(waits)
        step_idx, _, group, machine = pick
        if joined_at is not None:
            line.leave(me)
            priority = 0
        else:
            priority = box.priority(token) if box is not None else 0
        req_ctx = group.request_machine(machine, priority=priority)
        req, _ = req_ctx.__enter__()
        yield req
        if joined_at is None:
            if src is not None:
                self._add_buffer_block(src, block_start)
            release_src()
            return (req_ctx, req, req_ctx.sub_machine), None, None, step_idx
        return (req_ctx, req, req_ctx.sub_machine, joined_at), None, None, step_idx

    def _hand_off(
        self,
        src: str,
        nxt: str,
        release_src: Callable[[], None],
        in_box: Optional[Tuple["BufferBox", Any]],
        allowed: Optional[set] = None,
    ):
        """
        Wait until step `nxt` takes this job from `src`, then release_src()
        (frees the station slot or Buffer place the job was sitting in).
        in_box is (box, token) when the job sits in a Buffer box: it may then
        only leave on its turn — FIFO/LIFO, and front of its lane in 3D.

        Returns (pending_zero_buffer, box_place, carried):
          pending_zero_buffer: the next station's slot, already won (that
              station has Buffer Capacity 0, so the job goes straight in).
          box_place: (Buffer name, token) — the job now sits in that box.
          carried: (release_src, in_box), not released yet — the next Buffer
              box has capacity 0, so the job stays where it is until the step
              after that box takes it.
        Every wait is event-driven: the job moves the instant there is room.
        """
        nxt_station = self.stations_data[nxt]
        box, token = in_box if in_box is not None else (None, None)
        block_start = self.env.now

        def my_turn() -> bool:
            return box is None or box.may_leave(token)

        # Into a Buffer box.
        if _is_buffer(nxt_station):
            next_box = self.buffer_boxes[nxt]
            while not my_turn():
                yield box.changed()
            if next_box.passes_through:
                # Still blocked here until the step after the box takes it.
                def release_later(release=release_src, start=block_start):
                    self._add_buffer_block(src, start)
                    release()
                return None, None, (release_later, in_box)
            new_token = object()
            yield from next_box.enter(new_token)
            self._add_buffer_block(src, block_start)
            release_src()
            return None, (nxt, new_token), None

        # Into a zero-time junction (Connector, End, ...): always takes it.
        if _is_passthrough(nxt_station):
            while not my_turn():
                yield box.changed()
            release_src()
            return None, None, None

        resource = self.resources[nxt]
        unlimited = nxt_station.get("Buffer Unlimited", False)
        cap = nxt_station.get("Buffer Capacity", 0) or 0

        # Into a station with no waiting room (Buffer Capacity 0): queue for
        # its machine and go straight onto it. Jobs leaving a Buffer box queue
        # with that box's FIFO/LIFO priority, so the right one wins.
        if not unlimited and cap == 0:
            if box is not None:
                while not box.is_front(token):
                    yield box.changed()
            req_ctx = resource.request(priority=box.priority(token) if box is not None else 0, allowed=allowed)
            req, _ = req_ctx.__enter__()
            yield req
            self._add_buffer_block(src, block_start)
            release_src()
            # Read after the grant: a parallel station only picks the machine
            # (cyclic/random/successor) at that point.
            return (req_ctx, req, req_ctx.sub_machine), None, None

        # Into a station's own queue (Buffer Capacity N, or unlimited): move
        # on your turn, as soon as that queue has fewer than N waiting.
        while not (my_turn() and (unlimited or len(resource.queue) < cap)):
            waits = [resource.queue_changed()]
            if box is not None:
                waits.append(box.changed())
            yield self.env.any_of(waits)
        self._add_buffer_block(src, block_start)
        release_src()
        return None, None, None

    def _add_buffer_block(self, station_name: str, start: float) -> None:
        """Count the minutes station_name was blocked holding a finished job
        the next step couldn't take yet. Wall-clock: overlapping waits (e.g.
        two parallel machines blocked at once) are counted once."""
        station = self.stations_data[station_name]
        if self.env.now <= start or _is_passthrough(station):
            return
        blocked_until = station.get("_blocked_until", 0.0)
        new_block = max(0.0, self.env.now - max(start, blocked_until))
        station["_blocked_until"] = max(blocked_until, self.env.now)
        if new_block > 0:
            station["total_block_time"] = station.get("total_block_time", 0) + new_block
            station["buffer_blocked_time"] = station.get("buffer_blocked_time", 0) + new_block

    def _log_passthrough(
        self, resource_name: str, variant_id: int, variant_type: str, operation: str
    ) -> Dict[str, Any]:
        """
        Record a job's instant traversal of a Connector.

        No time passes and no resource is held, so there is nothing to measure
        — but the job trace should still show the job reaching this point,
        otherwise a Connector in the middle of a flow looks like a step where
        jobs silently vanish. Every duration field is zero and the station is
        credited a completed job so per-station counts stay consistent with the
        number of jobs that actually routed through it.
        """
        now_real = self.simulation_state["start_date"] + timedelta(minutes=self.env.now)
        stamp = now_real.strftime("%Y-%m-%d %H:%M:%S")

        station = self.stations_data[resource_name]
        station.setdefault("job_counts", {"waiting": 0, "processing": 0, "completed": 0})
        station["job_counts"]["completed"] += 1
        station["last_job_end_time"] = self.env.now
        if self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            station["completed_jobs_per_station"] = (
                station.get("completed_jobs_per_station", 0) + 1
            )

        entry = {
            "job_id": _format_job_id(variant_type, variant_id),
            "station_name": resource_name,
            "status": "Completed",
            "Completed_jobs": station.get("completed_jobs_per_station", 0),
            "Blocked Time": 0.0,
            "Waiting Time": 0.0,
            "Processing Time": 0.0,
            "process_start_time_real": stamp,
            "process_end_time_real": stamp,
            "station_downtime": 0.0,
            "pause_time": 0.0,
            "operators_downtime": 0.0,
            "total_rework_time": 0.0,
            "total_setup_time": 0.0,
            "material_unavailability": 0.0,
            "delay_reason": "No delay",
        }
        self.completion_log.setdefault(resource_name, []).append(entry)

        variant_name = f"{variant_type} {variant_id}"
        self.simulation_state["current_jobs"][variant_name] = f"Completed at {resource_name}"
        self.simulation_state["job_exit_times"][variant_name] = self.env.now
        logger.debug(
            "Connector '%s': %s#%s passed through instantly (op '%s')",
            resource_name, variant_type, variant_id, operation,
        )
        return entry

    def _close_passthrough(self, entry: Dict[str, Any], start: float) -> None:
        """A job leaves a Buffer box: its trace entry ends now, so the Job
        Trace and Canvas replay show it sitting in the box for that long."""
        entry["process_end_time_real"] = self._real_stamp()
        # Completed parts of a Buffer: parts that left it, after the warm-up.
        if self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
            station = self.stations_data[entry["station_name"]]
            station["buffer_parts_left"] = station.get("buffer_parts_left", 0) + 1
        waited = self.env.now - start
        if waited > 0:
            entry["delay_reason"] = f"Waited {round(waited, 2)} min in buffer"

    def _hold_in_last_buffer(self, entry: Dict[str, Any]) -> None:
        """A part stays in a Buffer that ends the line (no End): its trace
        entry runs to the end of the run, so the replay shows it sitting in
        the box. It never leaves, so it is not one of the Buffer's
        Completed parts (those that left it)."""
        end = self.simulation_state["start_date"] + timedelta(minutes=self.sim_config.get("SIM_TIME", self.env.now))
        entry["process_end_time_real"] = end.strftime("%Y-%m-%d %H:%M:%S")
        entry["delay_reason"] = "Stays in the last buffer (no End)"

    def _reject_job(
        self,
        resource_name: str,
        variant_name: str,
        trace_entry: Dict[str, Any],
        start_date: datetime,
    ) -> None:
        """
        A job turned away outright by a Worker Controller (Queue Policy =
        reject, queue already at Max Queue Size) — a genuinely new terminal
        outcome distinct from Completed or the horizon-cutoff "In Progress".
        Called from inside _perform_operation's `with resource.request()`
        block, AFTER blocked-time/setup bookkeeping already ran (the job did
        occupy the machine and get set up before discovering no Worker could
        be dispatched) — so this only undoes the "processing" job_count this
        job's own step already added, and appends the terminal outcome.
        Mirrors _log_passthrough's job-trace bookkeeping (so it doesn't just
        vanish from the log) but marks the outcome "Rejected" and does NOT
        count toward completed_jobs.
        """
        now_real = start_date + timedelta(minutes=self.env.now)
        stamp = now_real.strftime("%Y-%m-%d %H:%M:%S")

        self.stations_data[resource_name]["job_counts"]["processing"] -= 1
        self.stations_data[resource_name]["rejected_jobs"] = (
            self.stations_data[resource_name].get("rejected_jobs", 0) + 1
        )

        trace_entry.update({
            "status": "Rejected",
            "process_start_time_real": None,
            "process_end_time_real": stamp,
            "delay_reason": "Rejected — Worker Controller queue full",
        })

        self.simulation_state["rejected_jobs"] += 1
        self.simulation_state["current_jobs"][variant_name] = f"Rejected at {resource_name}"
        self.simulation_state["job_exit_times"][variant_name] = self.env.now
        self.simulation_state["in_progress_jobs"] = max(0, self.simulation_state["in_progress_jobs"] - 1)
        logger.debug("'%s' rejected at '%s' — Worker Controller queue full", variant_name, resource_name)

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
        preacquired: Optional[tuple] = None,
        hold_slot: bool = False,
        allowed_machines: Optional[set] = None,
        assembly_join: Optional[Callable[[Dict[str, Any]], Any]] = None,
    ):
        resource = self.resources[resource_name]
        station_cfg = self.stations_data[resource_name]
        # A Workplace naming a Worker Controller ("Worker Controller" field,
        # written by Canvas when a Worker Controller is wired to it) draws its
        # operator from that Controller's live WorkerPool instead of the
        # older static shift1/2/3 assignment below — see the acquire/release
        # around the main processing loop. Absent, or naming a Controller
        # with no pool (e.g. it has no Workers wired), falls back entirely
        # to the unchanged existing behaviour.
        pool = self.worker_pools.get(station_cfg.get("Worker Controller"))
        # A Conveyor transports rather than processes: the job rides it for a
        # transport time, but no operator is consumed (a belt runs itself) and
        # there is no changeover or rework, since nothing is being worked on.
        # Its capacity is set up in _init_resources; the belt itself (stop /
        # restart, first on first off) is the ConveyorBelt below.
        is_conveyor = _is_conveyor(station_cfg)
        belt = self.conveyor_belts.get(resource_name) if is_conveyor else None
        belt_token = object()
        at_belt_end = False
        sensor_at: Optional[float] = None
        sensor_passed = False

        def _check_sensor(moved: float) -> None:
            nonlocal sensor_passed
            if sensor_at is not None and not sensor_passed and moved >= sensor_at - 1e-9:
                sensor_passed = True
                cfg = self.stations_data[resource_name]
                cfg["sensor_passed"] = cfg.get("sensor_passed", 0) + 1
        # A station with 0 assigned operators is machine-only / a queue-buffer:
        # it must NOT gate on operator availability (#7). Keep the raw count so
        # we can branch on it, but use >=1 for the cycle-time division.
        has_operators = bool(num_operators) and not is_conveyor
        num_operators = num_operators or 1
        if is_conveyor:
            # Transport time is wall-clock travel along the belt — separate
            # from Process Time (see TimingEngine.get_process_time).
            adjusted_ct = _transport_time(station_cfg, duration)
            num_operators = 1
            # Sensor (record only): the job passes it once it has moved
            # position / speed minutes — belt stops don't count as moving.
            sensor_pos = _sensor_position(station_cfg)
            sensor_length = _positive_float(station_cfg.get("Conveyor Length"))
            sensor_at = (
                adjusted_ct * sensor_pos / sensor_length
                if sensor_pos is not None and sensor_length and adjusted_ct else None
            )
        else:
            # Process Time per the CT/PT/ST spec: the station's configured
            # operation duration, unmodified — see TimingEngine.
            adjusted_ct = self.timing.get_process_time({"duration": duration})
        # Per-station shift schedule (honours the station's own shift windows;
        # falls back to the global config when the station defines none).
        shift_cfg = self._station_shift_cfg.get(resource_name, self.sim_config)
        start_date = self.simulation_state["start_date"]
        first_station = SimulationUtils.is_first_station(resource_name, self.processflow_data)

        variant_name = f"{variant_type} {variant_id}"

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
        # The global STATION_DOWNTIME allowance models machine unavailability;
        # a conveyor is not a machine, so it is never charged this.
        station_downtime_budget = 0 if is_conveyor else self.sim_config.get("STATION_DOWNTIME", 0)

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
        # A zero-buffer hand-off (Buffer Capacity 0) already queued for and won
        # this station's slot before the job left the previous station — see
        # _process_variant's pending_zero_buffer. Reuse that slot instead of
        # requesting a second one, which would deadlock against itself on a
        # capacity-1 station. Absent, this is an ordinary request, unchanged.
        if preacquired is not None:
            req_ctx, req, sub_machine = preacquired[:3]
            # Came from a parallel group's shared line: the job arrived here
            # when it joined that line, so its wait there counts here.
            if len(preacquired) > 3:
                block_start = preacquired[3]
        else:
            # allowed_machines: Route by product on the station before.
            req_ctx = resource.request(priority=priority, allowed=allowed_machines)
            req, sub_machine = req_ctx.__enter__()
        # PDF section 7/9 FailurePolicy bookkeeping only applies to a
        # SubMachine that actually runs _run_failure_cycle (simulation_time
        # is not None) — a conveyor/passthrough's shared, high-capacity
        # SubMachine (simulation_time=None) must never have
        # begin_processing()/end_processing() called on it, since multiple
        # jobs can hold it at once and would stomp each other's
        # current_process_start/remaining_process_time on that one shared
        # object. Computed before the try/finally below (not inside it) so
        # it's always bound even if an exception occurs before the normal
        # begin_processing() call point.
        tracks_failures = getattr(sub_machine, "simulation_time", None) is not None
        try:
            yield req
            # Run over: the job ahead was cut 1e-6 before SIM_TIME (see the
            # horizon cap below) and freed this station in the last instant.
            # This job never really started here — leave it "Waiting", like
            # a job still queued when the run ends, and go no further.
            if self._run_over():
                yield self.env.event()
            # A parallel station only picks the machine (cyclic) once the
            # request is granted, so re-read it now. Single-machine stations
            # already knew it — unchanged for them.
            sub_machine = req_ctx.sub_machine
            tracks_failures = getattr(sub_machine, "simulation_time", None) is not None
            # Which parallel machine (1-based, matching the Canvas's "#1",
            # "#2", ... boxes) took this job — lets the Canvas replay show it
            # at the right box. Single-machine stations leave it out.
            if len(resource.sub_machines) > 1 and sub_machine in resource.sub_machines:
                trace_entry["machine"] = resource.sub_machines.index(sub_machine) + 1
            if belt is not None:
                belt.get_on(belt_token)
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

            # Assembly: the main part sits on the machine until its parts are
            # all in (not working meanwhile), then takes them in.
            if assembly_join is not None:
                parts_wait = yield from assembly_join(trace_entry)
                if parts_wait > 0:
                    trace_entry["Waiting for parts"] = round(parts_wait, 4)

            # --- Setup / changeover ---
            # Two independent triggers:
            #  - Variant-change setup: charged when this station's next job
            #    is a different variant than the one it last processed
            #    (matches Simul8/FlexSim/Arena's "changeover on type change"
            #    model) — same variant back-to-back incurs zero setup time
            #    from THIS trigger. Duration comes from TimingEngine.get_setup_time's
            #    sequence/product/fixed lookup.
            #  - Batch-dependent setup: charged every Nth unit of the SAME
            #    variant run back-to-back (see TimingEngine.is_batch_setup_due), using the
            #    station's separate "Batch Setup Time" duration. Independent
            #    of variant-change setup — a station can have either, both,
            #    or neither configured.
            # Runs while still holding the resource, shift-aware, before
            # process time starts. A conveyor has no tooling to change over —
            # a different variant simply rides the same belt, so both
            # triggers are skipped for it.
            last_variant = self.stations_data[resource_name].get("last_variant_type")
            variant_changed = last_variant is not None and variant_type != last_variant
            if is_conveyor:
                setup_time = 0
            elif variant_changed or last_variant is None:
                setup_time = self.timing.get_setup_time(
                    self.stations_data[resource_name], self.setup_matrix.get(resource_name),
                    last_variant, variant_type,
                )
            elif self.timing.is_batch_setup_due(self.stations_data[resource_name], last_variant, variant_type):
                setup_time = self.stations_data[resource_name].get("Batch Setup Time", 0) or 0
            else:
                setup_time = 0
            if setup_time > 0:
                setup_time_remaining = setup_time
                su_start = self.env.now
                # Any out-of-shift wait inside THIS loop still advances
                # env.now, which su_dur (below) is measured across — track it
                # separately so it can be subtracted back out, otherwise that
                # wait gets billed to BOTH total_setup_time (via su_dur, which
                # spans the whole loop) AND total_pause (its own accumulator),
                # double-counting the same minutes under two different KPIs.
                su_pause = 0.0
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
                        # Same horizon cap as the processing loop below — a
                        # chunk scheduled to land EXACTLY on SIM_TIME never
                        # fires (SimPy's env.run(until=X) only processes
                        # events strictly before X), so this partial setup
                        # progress would silently vanish instead of being
                        # credited to total_setup_time. Epsilon keeps it
                        # strictly inside the horizon so the timeout resolves.
                        horizon_remaining = self.sim_config["SIM_TIME"] - self.env.now
                        if horizon_remaining <= 0:
                            break
                        chunk = min(chunk, horizon_remaining - 1e-6 if horizon_remaining > 1e-6 else horizon_remaining)
                        if chunk <= 0:
                            break
                        su_chunk_start = self.env.now
                        yield self.env.timeout(chunk)
                        record(sub_machine.state_log, "setup", su_chunk_start, self.env.now)
                        setup_time_remaining -= chunk
                        setup_time_remaining = max(0.0, setup_time_remaining)
                    else:
                        real_time = start_date + timedelta(minutes=self.env.now)
                        wait = SimulationUtils.wait_until_next_shift(shift_cfg, real_time, shifts_per_day)
                        if (wait + self.simulation_state["total_simulated_time"]) > self.sim_config["SIM_TIME"]:
                            break
                        yield self.env.timeout(wait)
                        total_pause += wait
                        su_pause += wait

                su_dur = self.env.now - su_start - su_pause
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
            process_time = adjusted_ct
            process_start = self.env.now
            processing_time = 0.0
            horizon_cutoff = False

            # PDF section 7/9: register this job's full process_time with the
            # machine so a mid-operation failure can compute "elapsed vs.
            # remaining" (fail()) and apply RESUME/RESTART/SCRAP (repair()).
            # tracks_failures (computed above, before the try block) is False
            # for a conveyor/passthrough's shared SubMachine — see its comment.
            if tracks_failures:
                sub_machine.begin_processing(process_time)

            # --- Worker pool acquire (Workplace wired to a Worker Controller) ---
            # Held for the job's WHOLE stay at this station (not re-acquired
            # per chunk, unlike the static operator check below) — a pooled
            # Worker is genuinely occupied here until the job leaves, exactly
            # like the machine resource itself. If the Controller's Queue
            # Policy is "reject" and its queue is already full, the request
            # is turned away outright (PoolRejected) — a genuinely new
            # terminal outcome distinct from Completed/In Progress, handled
            # by _reject_job below and released resource.request() context.
            pool_worker = None
            if pool is not None:
                try:
                    pool_worker = yield from pool.acquire(resource_name)
                except PoolRejected:
                    self._reject_job(resource_name, variant_name, trace_entry, start_date)
                    return "rejected"
                travel_time = pool.travel_time_for(pool_worker, resource_name)
                if travel_time > 0:
                    travel_start = self.env.now
                    yield self.env.timeout(travel_time)
                    total_operator_dt += self.env.now - travel_start
                # The Worker's worked time here starts now (walking excluded).
                pool.start_work(pool_worker, resource_name)

            # A sensor at the very start of the belt is passed on getting on —
            # unless the run is over: a job let on in the last instant (the
            # job ahead cut 1e-6 before SIM_TIME) never really boarded.
            if not self._run_over():
                _check_sensor(0.0)

            # --- Main processing loop (shift-aware) ---
            while process_time > 0:
                real_time = start_date + timedelta(minutes=self.env.now)

                if SimulationUtils.is_active_shift(shift_cfg, real_time, shifts_per_day):
                    active_elapsed, is_shift_start = SimulationUtils.calculate_active_shift_time(
                        shift_cfg, real_time, shifts_per_day
                    )
                    used = 0 if is_shift_start else active_elapsed % self.sim_config.get("ACTIVE_PROCESSING_TIME", 480)
                    available = max(0.0, self.sim_config.get("ACTIVE_PROCESSING_TIME", 480) - used)

                    while available > 0:
                        # Machine downtime — checked against the specific
                        # sub-machine this job is on, so a failure on a
                        # different parallel unit at this station never
                        # blocks this job (see MachineGroup in machine.py).
                        available, dt_added, failure_outcome = yield from self._handle_machine_downtime(
                            sub_machine, variant_name, resource_name, shifts_per_day, available, start_date
                        )
                        total_station_dt += dt_added
                        station_downtime_budget -= dt_added

                        # PDF section 7/8 FailurePolicy, applied to THIS job's
                        # remaining work after a failure/repair cycle that
                        # happened while it sat here:
                        #   RESUME  — remaining_process_time already equals
                        #             process_time minus elapsed (no change
                        #             here; this is today's existing behavior).
                        #   RESTART — the whole operation starts over.
                        #   SCRAP   — the in-progress part is discarded; this
                        #             job ends now rather than completing.
                        if failure_outcome == "restart":
                            process_time = sub_machine.remaining_process_time
                            # The chunk(s) already credited to processing_time
                            # before this failure were discarded by the
                            # restart (not kept, redone from scratch) — zero
                            # them back out so busy_time/utilization only
                            # ever reflects the eventually-kept work, same
                            # convention this engine already uses for rework
                            # (tracked separately, never folded into
                            # processing_time/busy_time).
                            processing_time = 0.0
                            self._log_event(variant_name, resource_name, shifts_per_day,
                                            "failure_policy_restart", self.env.now, self.env.now,
                                            process_time=process_time, start_date=start_date)
                        elif failure_outcome == "scrap":
                            self._log_event(variant_name, resource_name, shifts_per_day,
                                            "failure_policy_scrap", self.env.now, self.env.now,
                                            start_date=start_date)
                            trace_entry.update({
                                "status": "Scrapped",
                                "process_start_time_real": (start_date + timedelta(minutes=process_start)).strftime("%Y-%m-%d %H:%M:%S"),
                                "process_end_time_real": (start_date + timedelta(minutes=self.env.now)).strftime("%Y-%m-%d %H:%M:%S"),
                                "delay_reason": "Part scrapped — machine failed mid-operation (Failure Policy: Scrap)",
                            })
                            self.stations_data[resource_name]["job_counts"]["processing"] -= 1
                            # A scrapped job has left the line for good —
                            # same terminal bookkeeping as _reject_job, so it
                            # isn't still reported as "in progress".
                            self.simulation_state["scrapped_jobs"] += 1
                            if self.env.now >= self.sim_config.get("WARMUP_TIME", 0):
                                self.stations_data[resource_name]["scrapped_parts"] = (
                                    self.stations_data[resource_name].get("scrapped_parts", 0) + 1)
                            self.simulation_state["in_progress_jobs"] = max(
                                0, self.simulation_state["in_progress_jobs"] - 1
                            )
                            # Worker pool release — mirrors the ordinary
                            # completion/horizon-cutoff paths below, which
                            # this early return skips past.
                            if pool is not None and pool_worker is not None:
                                yield from pool.release(pool_worker, resource_name)
                            return "scrapped"

                        # Operator availability — the older static shift1/2/3
                        # assignment. Skipped entirely once a Worker Controller
                        # pool is wired (pool is not None): that Worker's own
                        # acquire/release above already gates this station,
                        # and running both would double-gate the same job.
                        if pool is None and self.operators_data and has_operators:
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
                                    available, op_dt_added, process_time = yield from self._handle_operator(
                                        operator, resource_name, variant_name, shifts_per_day,
                                        available, process_time, start_date
                                    )
                                    total_operator_dt += op_dt_added

                        # Material shortage — a conveyor consumes no material,
                        # it only moves what is already on it.
                        shortage = 0 if is_conveyor else SimulationUtils.check_material_shortage(
                            self.stations_data, resource_name
                        )
                        if shortage > 0:
                            ms_start = self.env.now
                            yield self.env.timeout(min(shortage, available))
                            ms_dur = self.env.now - ms_start
                            material_unavail += ms_dur
                            available -= ms_dur
                            available = max(0.0, available)

                        # Process chunk
                        if process_time <= 0:
                            break
                        # Conveyor stopped (its front job can't leave yet):
                        # this job doesn't move until it restarts, then
                        # re-checks the shift from the top.
                        if belt is not None and belt.stopped:
                            stop_start = self.env.now
                            while belt.stopped:
                                yield belt.changed()
                            total_blocked += self.env.now - stop_start
                            record(sub_machine.state_log, "block", stop_start, self.env.now)
                            break
                        chunk = min(process_time, available)
                        # Cap at the next break so a break shorter than this
                        # chunk still actually pauses processing — otherwise
                        # a single env.timeout() could run straight through a
                        # break with no intermediate is_active_shift check.
                        chunk_real_time = start_date + timedelta(minutes=self.env.now)
                        until_break = SimulationUtils.minutes_until_next_break(shift_cfg, chunk_real_time, shifts_per_day)
                        chunk = min(chunk, until_break)
                        # Cap at the remaining simulation horizon too — a chunk
                        # scheduled to land EXACTLY on SIM_TIME never fires:
                        # SimPy's env.run(until=X) only processes events
                        # strictly before X, so yield env.timeout(chunk) would
                        # sit unresolved forever once the stepped run loop
                        # stops advancing, and processing_time would never
                        # accumulate for the real (partial) work that DID
                        # happen — the job just shows as still "Waiting" with
                        # zero credit. Subtracting a tiny epsilon keeps the
                        # scheduled time strictly inside the horizon so the
                        # timeout actually resolves and this partial progress
                        # gets credited to busy_time instead of silently lost.
                        horizon_remaining = self.sim_config["SIM_TIME"] - self.env.now
                        if self._run_over():
                            # No usable horizon left to schedule another
                            # timeout in — same terminal condition as running
                            # out of horizon in the "outside shift" branch
                            # below, so it needs the same horizon_cutoff flag
                            # to make the partial-progress credit-back (see
                            # "Job was cut short by the simulation horizon"
                            # below) actually fire for THIS branch too.
                            horizon_cutoff = True
                            break
                        chunk = min(chunk, horizon_remaining - 1e-6)
                        if chunk <= 0:
                            break
                        # Arm the machine to interrupt THIS sleep the instant
                        # a failure starts, instead of sleeping through the
                        # whole chunk oblivious to a failure that starts and
                        # ends entirely within it (see SubMachine.begin_chunk_
                        # sleep's docstring — this was a real, confirmed gap:
                        # a failure fully inside one chunk's sleep window
                        # never reached _handle_machine_downtime at all,
                        # so that job recorded zero downtime and finished
                        # exactly on its original schedule despite the
                        # machine genuinely being down for part of it).
                        chunk_start = self.env.now
                        if tracks_failures:
                            sub_machine.begin_chunk_sleep(self.env.active_process)
                        # A conveyor stopping mid-chunk interrupts this sleep
                        # the same way a failure does (see ConveyorBelt.stop).
                        if belt is not None:
                            belt.ride_start(self.env.active_process)
                        try:
                            yield self.env.timeout(chunk)
                            elapsed = chunk
                        except simpy.Interrupt:
                            # Failure fired mid-sleep — credit only the
                            # partial chunk that genuinely elapsed before
                            # the interrupt, then loop back to the top of
                            # `while available > 0:`, where
                            # _handle_machine_downtime will now correctly
                            # observe sub_machine.working == False (it was
                            # just set, before this interrupt was raised)
                            # and wait out the repair / apply the
                            # FailurePolicy exactly as it already does for
                            # a failure that starts between chunks.
                            elapsed = self.env.now - chunk_start
                        finally:
                            if tracks_failures:
                                sub_machine.end_chunk_sleep()
                            if belt is not None:
                                belt.ride_end(self.env.active_process)
                        processing_time += elapsed
                        record(sub_machine.state_log, "work", chunk_start, chunk_start + elapsed)
                        available -= elapsed
                        process_time -= elapsed
                        available = max(0.0, available)
                        process_time = max(0.0, process_time)
                        _check_sensor(adjusted_ct - process_time)

                    if horizon_cutoff:
                        # Set just above when the inner loop ran out of
                        # horizon to schedule another chunk in — stop the
                        # OUTER loop too, otherwise it would just re-enter
                        # with the same exhausted env.now and loop forever
                        # (no further yield ever advances simulated time).
                        break

                    remaining_dt = max(0.0, station_downtime_budget)
                    total_station_dt += remaining_dt
                    if remaining_dt > 0:
                        dt_start = self.env.now
                        yield self.env.timeout(remaining_dt)
                        record(sub_machine.state_log, "fail", dt_start, self.env.now)

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

            # First on, first off: a job that finished its transport time
            # still waits behind the jobs that got on the belt before it.
            if belt is not None and not horizon_cutoff:
                front_start = self.env.now
                while belt.jobs and belt.jobs[0] is not belt_token:
                    yield belt.changed()
                total_blocked += self.env.now - front_start
                record(sub_machine.state_log, "block", front_start, self.env.now)
                at_belt_end = True

            total_processing += processing_time
            # Process Time itself was only ever visible indirectly (inferred
            # from the gap to the NEXT station's arrival) — log it directly
            # so it's traceable the same way setup/blocked/waiting already
            # are. processing_time is the REAL elapsed work time (may be
            # less than adjusted_ct if horizon_cutoff ended the job early).
            self._log_event(variant_name, resource_name, shifts_per_day, "process completed",
                            process_start, self.env.now, process_time=processing_time,
                            horizon_cutoff=horizon_cutoff, start_date=start_date)

            # --- Worker pool release --- the Worker is free for the
            # Controller to dispatch elsewhere as soon as this job leaves the
            # station, win or lose (horizon cutoff included) — it remembers
            # THIS station as its last_workplace either way, since it did
            # physically stay here for however long it just processed.
            if pool is not None and pool_worker is not None:
                yield from pool.release(pool_worker, resource_name)

            # Job was cut short by the simulation horizon before finishing its
            # process time — do not count it as completed or bill its full
            # nominal duration; only the real partial processing_time happened.
            # Still record a completion_log entry (status "In Progress") so
            # the job trace doesn't silently drop it — a common gap in other
            # DES tools' entity logs (see _format_job_id's docstring context).
            if horizon_cutoff and process_time > 0:
                self.stations_data[resource_name]["job_counts"]["processing"] -= 1
                self.stations_data[resource_name]["busy_time"] = (
                    self.stations_data[resource_name].get("busy_time", 0) + processing_time
                )
                # _determine_delay_reason falls back to "No delay" when none
                # of its seven signals (breakdown/operator/material/setup/
                # rework/queue/pause) has a nonzero duration — correct for a
                # job that finished cleanly, but WRONG here: this job never
                # finished at all, it just happened to start processing
                # immediately with nothing blocking it before the horizon
                # cut it off mid-chunk. Compute the seven-signal reason
                # first, then only use it if it found a REAL cause;
                # otherwise label this cutoff explicitly so "still running
                # out of time" is never confused with "completed with zero
                # friction."
                six_signal_reason = _determine_delay_reason(
                    total_blocked, total_station_dt, total_operator_dt,
                    total_setup, material_unavail, total_rework, total_pause,
                )
                trace_entry.update({
                    "status": "In Progress",
                    "Processing Time": processing_time,
                    "process_start_time_real": (start_date + timedelta(minutes=process_start)).strftime("%Y-%m-%d %H:%M:%S"),
                    "process_end_time_real": None,
                    "delay_reason": (
                        six_signal_reason if six_signal_reason != "No delay"
                        else "Still processing — simulation ended before this job finished"
                    ),
                })
                return "in_progress"

            # --- Rework ---
            # Nothing is machined on a conveyor, so there is no defect to
            # rework — transport never produces scrap.
            current_shift = SimulationUtils.get_active_shift(
                self.env, self.simulation_state, shift_cfg, shifts_per_day
            )
            operator = SimulationUtils.operator_available(
                self.stations_data, self.operators_data, resource_name, current_shift
            )
            rework_time = 0 if is_conveyor else SimulationUtils.check_rework(
                self.stations_data, resource_name, adjusted_ct, operator
            )
            if rework_time > 0:
                rw_start = self.env.now
                self.stations_data[resource_name]["rework_events"] = (
                    self.stations_data[resource_name].get("rework_events", 0) + 1
                )
                # Same double-counting risk as the setup loop above: any
                # out-of-shift wait inside THIS loop still advances env.now,
                # which rw_dur (below) is measured across — track it
                # separately so it can be subtracted back out.
                rw_pause = 0.0
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
                        rw_chunk_start = self.env.now
                        yield self.env.timeout(chunk)
                        record(sub_machine.state_log, "work", rw_chunk_start, self.env.now)
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
                        rw_pause += wait

                rw_dur = self.env.now - rw_start - rw_pause
                total_rework += rw_dur
                self.stations_data[resource_name]["total_rework_time"] = (
                    self.stations_data[resource_name].get("total_rework_time", 0) + rw_dur
                )
                self._log_event(variant_name, resource_name, shifts_per_day, "rework completed",
                                rw_start, self.env.now, rework_time=rw_dur, start_date=start_date)
        finally:
            # PDF section 7/9: this job no longer has processing in flight on
            # sub_machine — clears current_process_start/remaining_process_time
            # so a LATER job on this same machine doesn't inherit stale state.
            # Same tracks_failures gate as begin_processing() above — a
            # conveyor's shared, high-capacity SubMachine never had
            # begin_processing() called on it either, so nothing to clear.
            if tracks_failures:
                sub_machine.end_processing()

            # Releases the slot at exactly the point the previous `with
            # resource.request(...)` block did, for both the ordinary and the
            # pre-acquired (zero-buffer) cases.
            #
            # hold_slot defers that release to the caller: under zero-buffer
            # rules the station stays OCCUPIED by the finished job until the
            # next station physically takes it, so the station cannot start
            # another job in the meantime. Releasing here instead let the next
            # queued job seize the machine immediately, which is a hidden
            # one-slot buffer — the station then ran several jobs ahead of its
            # downstream neighbour instead of at most one.
            #
            # On a conveyor, a front job held here is stuck at the end of the
            # belt, so the whole belt stops until the next station takes it.
            if hold_slot and belt is not None:
                if at_belt_end:
                    belt.stop(belt_token)
                self._held_slot = _HeldBlocked(_BeltSlot(req_ctx, belt, belt_token), sub_machine, self.env)
            elif hold_slot:
                self._held_slot = _HeldBlocked(req_ctx, sub_machine, self.env)
            else:
                req_ctx.__exit__(None, None, None)
                if belt is not None:
                    belt.get_off(belt_token)

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
            # Per-station Cycle Time (CT/PT/ST spec): arrival (block_start,
            # set before this job requested the station) to departure
            # (process_end, just above) — the entity's TOTAL elapsed time at
            # this one station, distinct from Processing Time above (which
            # is only the active working portion of that same span).
            "Cycle Time": self.timing.get_cycle_time(block_start, process_end),
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
                total_setup, material_unavail, total_rework, total_pause,
            ),
            **pcts,
        })

        # Machine idle detection
        if resource.count == 0 and len(resource.queue) == 0:
            resource.wait_start_time = self.env.now

    # ------------------------------------------------------------------
    # Sub-operation helpers (keeps _perform_operation readable)
    # ------------------------------------------------------------------

    def _handle_machine_downtime(self, sub_machine, variant_name, resource_name, shifts_per_day, available, start_date):
        """Wait out any machine downtime; return updated (available, downtime_added, failure_outcome).

        Checks the specific SubMachine this job is on, not the station's
        whole MachineGroup, so a failure on a different parallel unit at
        this station never blocks this job.

        failure_outcome is the sub_machine's FailurePolicy applied to THIS
        job's in-flight work (PDF section 7/9: "resume" / "restart" / "scrap"),
        or None if no failure happened while this job was waiting here."""
        dt_added = 0.0
        downtime_start = None
        failure_outcome = None
        while hasattr(sub_machine, "working") and not sub_machine.working:
            if downtime_start is None:
                downtime_start = self.env.now
            # Wake at the exact instant repair/PM finishes (machine.py fires
            # working_event right after setting working=True), not on a fixed
            # poll tick — polling every 10 min rounded every repair up to the
            # next multiple of 10 and left the station idle after repair.
            # Loop re-checks in case another failure/PM starts the same instant.
            yield sub_machine.working_event
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
            failure_outcome = getattr(sub_machine, "last_failure_outcome", None)
        return max(0.0, available), dt_added, failure_outcome

    def _handle_operator(self, operator, resource_name, variant_name, shifts_per_day,
                          available, process_time, start_date):
        """
        Wait for operator if unavailable; adjust process_time by skill.
        Returns (available, op_downtime_added, process_time).
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

        # Adjust process_time by operator skill
        if operator:
            adjusted_times = [process_time * 1.0 for _, _ in operator]  # skill factor placeholder → 1.0
            process_time = sum(adjusted_times) / len(adjusted_times)

        return max(0.0, available), op_dt_added, process_time

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
            box = self.buffer_boxes.get(name)
            if box is not None:
                # A Buffer box does no work, so its "Blocked (full) time" is
                # simply how long it sat full, as a share of the run.
                full = box.full_time_until(self.env.now)
                sim_time = self.sim_config.get("SIM_TIME", 0) or 0
                station["buffer_blocked_time"] = round(full, 2)
                station["buffer_blocked_ratio"] = round(full / sim_time * 100, 2) if sim_time > 0 else 0.0

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

    def _calc_avg_cycle_time(self, station_name: str) -> float:
        entries = self.completion_log.get(station_name, [])
        cts = [e["Cycle Time"] for e in entries if e.get("status") == "Completed" and "Cycle Time" in e]
        return round(sum(cts) / len(cts), 2) if cts else 0.0

    def _calc_max_cycle_time(self, station_name: str) -> float:
        """Worst-case (highest) Cycle Time across this station's completed
        jobs — surfaces an outlier job that an average would hide."""
        entries = self.completion_log.get(station_name, [])
        cts = [e["Cycle Time"] for e in entries if e.get("status") == "Completed" and "Cycle Time" in e]
        return round(max(cts), 2) if cts else 0.0

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
                # Only set for a "Buffer Config Mode": "3D" Buffer (see
                # _init_buffer_boxes) — None for every 2D/scalar station,
                # same "absent means not applicable" convention as
                # failure_counts_per_machine above.
                "rack_lane_count": (
                    self.buffer_boxes[name].rack.lane_count
                    if name in self.buffer_boxes and self.buffer_boxes[name].rack is not None else None
                ),
                "rack_occupied": (
                    len(self.buffer_boxes[name].items)
                    if name in self.buffer_boxes and self.buffer_boxes[name].rack is not None else None
                ),
                "completed_jobs": s.get("completed_jobs_per_station", 0),
                "throughput": calc_station_throughput(s.get("completed_jobs_per_station", 0), sim_time),
                "busy_time": s.get("busy_time", 0),
                "total_waiting_time": s.get("total_waiting_time", 0),
                "avg_block_time": s.get("avg_block_time", 0),
                "failure_breakdowns": s.get("failure_breakdowns", 0),
                "failure_counts_per_machine": s.get("failure_counts_per_machine", []),
                "pm_breakdowns": s.get("pm_breakdowns", 0),
                "operator_per_station": s.get("operator_per_station", 1),
                "capacity": s.get("capacity", 1),
                # Conveyor only — None for every other station.
                "conveyor_length": _positive_float(s.get("Conveyor Length")) if _is_conveyor(s) else None,
                "conveyor_speed": _conveyor_speed(s) if _is_conveyor(s) else None,
                "transport_time": _transport_time(s, None) if _is_conveyor(s) else None,
                # Conveyor with a sensor only — None otherwise.
                "sensor_passed": s.get("sensor_passed", 0) if _sensor_position(s) is not None else None,
                # Assembly only: minutes its main parts waited on it for parts.
                "parts_wait_time": s.get("parts_wait_time", 0) if name in getattr(self, "assembly_specs", {}) else None,
                "avg_cycle_time": self._calc_avg_cycle_time(name),
                "max_cycle_time": self._calc_max_cycle_time(name),
            }
            for name, s in self.stations_data.items()
        }

        completed_jobs = self.simulation_state.get("completed_jobs", 0)
        self.simulation_state["summary"] = build_summary(completed_jobs, sim_time, station_stats)

        return {
            "simulation_state": self.simulation_state,
            "station_stats": station_stats,
            "job_log": {},
            "completion_log": self.completion_log,
            "bottleneck_store": self.bottleneck_store,
            "worker_pool_stats": {name: pool.get_stats(float(self.sim_config.get("WARMUP_TIME", 0) or 0))
                                  for name, pool in self.worker_pools.items()},
            "station_states": self._station_states(),
            "buffer_states": self._buffer_states(),
            # Start: parts delivered (by Start, product); End: parts collected
            # (by the last station before it, the route's product, the part's
            # name — Car, a Dismantle piece, ...) — after the warm-up.
            "parts_flow": {"delivered": self._delivered, "collected": self._collected},
        }

    def _buffer_states(self) -> Dict[str, Dict[str, float]]:
        """Statistical analysis per Buffer: Empty / Occupied / Full % of its
        operating time, after the warm-up (see state_stats.buffer_states)."""
        end = self.env.now
        start = min(float(self.sim_config.get("WARMUP_TIME", 0) or 0), end)
        out: Dict[str, Dict[str, float]] = {}
        for name, box in self.buffer_boxes.items():
            cfg = self.stations_data.get(name, {})
            levels = box.level_intervals(end)
            out[name] = buffer_states(
                levels["occupied"], levels["full"], self._station_shift_cfg.get(name, self.sim_config),
                cfg.get("shifts_per_day", 1), self.simulation_state["start_date"], end, start)
            # Parts, as for a station: in the buffer at the end of the run;
            # left it (moved on) after the warm-up; scrap — a buffer never
            # scraps a part, always 0.
            out[name]["current_parts"] = len(box.items)
            out[name]["completed_parts"] = cfg.get("buffer_parts_left", 0)
            out[name]["scrapped_parts"] = 0
        return out

    def _station_states(self) -> Dict[str, Dict[str, float]]:
        """Statistical analysis per working station (not Start / End /
        Buffer / Connector / Worker / Workplace / Worker Controller): Working
        / Free / Setup / Blocked / Failed % of its operating time — see
        state_stats. Measured after the warm-up, like the other KPIs: from
        WARMUP_TIME to the end of the run (env.now — SIM_TIME is cut to the
        measured window's length while the results are made)."""
        end = self.env.now
        start = min(float(self.sim_config.get("WARMUP_TIME", 0) or 0), end)
        out: Dict[str, Dict[str, float]] = {}
        for name, group in self.resources.items():
            cfg = self.stations_data.get(name, {})
            if _is_passthrough(cfg):
                continue
            out[name] = station_states(
                group.sub_machines, self._station_shift_cfg.get(name, self.sim_config),
                cfg.get("shifts_per_day", 1), self.simulation_state["start_date"], end, start)
            # Parts: on the station's machine(s) at the end (being worked on,
            # or finished and waiting to leave — not the queue in front;
            # a conveyor: the parts on the belt); completed (good) and
            # scrapped after the warm-up; Dismantle: its output components.
            belt = self.conveyor_belts.get(name)
            out[name]["current_parts"] = (len(belt.jobs) if belt is not None
                                          else sum(len(sm.users) for sm in group.sub_machines))
            out[name]["completed_parts"] = cfg.get("completed_jobs_per_station", 0)
            out[name]["scrapped_parts"] = cfg.get("scrapped_parts", 0)
            out[name]["output_components"] = (cfg.get("output_components", 0)
                                              if _station_type(cfg) == "Dismantle" else None)
        return out

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

        def _avg_per_machine(name):
            """Elementwise mean of each sub-machine's failure count across
            replications. Sub-machine count is fixed per scenario (=
            station capacity) for the whole run, so lists should always be
            the same length — padding with 0 is just a defensive guard,
            not an expected path. Note: sum(result) may not exactly equal
            the separately-rounded "failure_breakdowns" mean above, since
            sum-of-rounded-means isn't always rounded-mean-of-sums."""
            lists = [r["station_stats"][name].get("failure_counts_per_machine", []) for r in results]
            if not lists or not any(lists):
                return []
            width = max(len(l) for l in lists)
            return [
                round(stats_lib.mean([l[i] if i < len(l) else 0 for l in lists]))
                for i in range(width)
            ]

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
                "failure_counts_per_machine": _avg_per_machine(name),
                "pm_breakdowns":          round(stats_lib.mean(_s("pm_breakdowns"))),
                "operator_per_station":   results[0]["station_stats"][name].get("operator_per_station", 1),
                "capacity":               results[0]["station_stats"][name].get("capacity", 1),
                "conveyor_length":        results[0]["station_stats"][name].get("conveyor_length"),
                "conveyor_speed":         results[0]["station_stats"][name].get("conveyor_speed"),
                "transport_time":         results[0]["station_stats"][name].get("transport_time"),
                "sensor_passed": (
                    round(stats_lib.mean(_s("sensor_passed")))
                    if results[0]["station_stats"][name].get("sensor_passed") is not None else None
                ),
                "avg_cycle_time":         round(stats_lib.mean(_s("avg_cycle_time")), 2),
                # Worst case across replications too, not averaged — a
                # replication with one bad outlier job shouldn't get
                # smoothed away by the others.
                "max_cycle_time":         round(max(_s("max_cycle_time")), 2) if _s("max_cycle_time") else 0.0,
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
        # rejected_jobs (Worker Controller Queue Policy = reject) was
        # previously dropped here entirely for multi-replication runs — a
        # scenario using a rejecting pool would show 0 rejections the moment
        # more than one replication was run, even though single-run results
        # correctly reported it.
        avg_rejected = round(stats_lib.mean(
            [r.get("simulation_state", {}).get("rejected_jobs", 0) for r in results]
        ))
        avg_scrapped = round(stats_lib.mean(
            [r.get("simulation_state", {}).get("scrapped_jobs", 0) for r in results]
        ))

        # Average each Worker Controller's pool stats across replications —
        # previously dropped entirely (worker_pool_stats had no key at all in
        # this method's return value), so the View-mode "Worker Pool" panel
        # showed "no pool data" for a properly-wired Controller the moment a
        # multi-replication run was used instead of a single run.
        controller_names = set()
        for r in results:
            controller_names.update(r.get("worker_pool_stats", {}).keys())
        aggregated_pool_stats: Dict[str, Any] = {}
        for name in controller_names:
            def _p(key, _name=name):
                return [r.get("worker_pool_stats", {}).get(_name, {}).get(key, 0) for r in results]
            aggregated_pool_stats[name] = {
                "workers_busy":       stats_lib.mean(_p("workers_busy")),
                "workers_idle":       stats_lib.mean(_p("workers_idle")),
                "queue_length":       stats_lib.mean(_p("queue_length")),
                "jobs_completed":     round(stats_lib.mean(_p("jobs_completed"))),
                "jobs_rejected":      round(stats_lib.mean(_p("jobs_rejected"))),
                "avg_wait_time":      stats_lib.mean(_p("avg_wait_time")),
                "worker_utilization": stats_lib.mean(_p("worker_utilization")),
                "workers": _average_workers([r.get("worker_pool_stats", {}).get(name, {}).get("workers", [])
                                             for r in results]),
            }

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
                "rejected_jobs": avg_rejected,
                "scrapped_jobs": avg_scrapped,
                "total_simulated_time": avg_sim_time,
                "summary": agg_summary,
                # True if ANY replication was cut short by a Stop request —
                # _execute_run uses this to mark the whole run "stopped"
                # rather than "completed" even under multi-replication.
                "stopped_early": any(
                    r.get("simulation_state", {}).get("stopped_early") for r in results
                ),
                # Assembly: parts used up / attached (average), the assemblies
                # of the replication the replay shows, and the warnings.
                "assembled_parts": round(stats_lib.mean(
                    [r.get("simulation_state", {}).get("assembled_parts", 0) for r in results])),
                "assemblies": results[-1].get("simulation_state", {}).get("assemblies", {}),
                "dismantles": results[-1].get("simulation_state", {}).get("dismantles", {}),
                "warnings": results[0].get("simulation_state", {}).get("warnings", []),
                # Same replication as completion_log, for the Canvas job replay.
                "job_release_times": results[-1].get("simulation_state", {}).get("job_release_times", {}),
                "job_finish_times": results[-1].get("simulation_state", {}).get("job_finish_times", {}),
            },
            "completion_log": last_log,
            "bottleneck_store": aggregated_bottlenecks,
            "worker_pool_stats": aggregated_pool_stats,
            # Parts delivered / collected, averaged over replications.
            "parts_flow": {
                kind: _average_counts([r.get("parts_flow", {}).get(kind, {}) for r in results])
                for kind in ("delivered", "collected")
            },
            # Statistical analysis per Buffer, averaged over replications.
            "buffer_states": {
                name: {key: stats_lib.mean([r.get("buffer_states", {}).get(name, {}).get(key, 0.0) for r in results])
                       for key in ("empty", "occupied", "full", "operating_time",
                                   "current_parts", "completed_parts", "scrapped_parts")}
                for name in results[0].get("buffer_states", {})
            },
            # Statistical analysis per station, averaged over replications.
            "station_states": {
                name: {
                    **{key: stats_lib.mean([r.get("station_states", {}).get(name, {}).get(key, 0.0) or 0.0 for r in results])
                       for key in ("working", "free", "setup", "blocked", "failed", "operating_time",
                                   "current_parts", "completed_parts", "scrapped_parts")},
                    "output_components": (
                        stats_lib.mean([r.get("station_states", {}).get(name, {}).get("output_components") or 0 for r in results])
                        if results[0]["station_states"][name].get("output_components") is not None else None),
                }
                for name in results[0].get("station_states", {})
            },
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
        # job_log used to accumulate every entry here too, but nothing reads
        # it back (the frontend's Job Trace tab uses completion_log, not
        # job_log) and on large scenarios it grows into gigabytes of live
        # objects, which was crashing the backend on big runs. The full
        # timeline is still available via the logger.info call below.
        logger.info(
            "[%s] variant=%s station=%s sim_t=%.2f->%.2f real=%s->%s%s",
            event, variant_name, station, start, end,
            entry["start_time_real"], entry["end_time_real"],
            (" " + " ".join(f"{k}={v}" for k, v in kwargs.items())) if kwargs else "",
        )

    @staticmethod
    def _calc_pcts(processing, blocked, station_dt, pause, op_dt, rework, mat_unavail, waiting, total_shift_min, setup=0.0):
        return calc_time_percentages(processing, blocked, station_dt, pause, op_dt, rework, mat_unavail, waiting, total_shift_min, setup)


# ---------------------------------------------------------------------------
# Statistics helper
# ---------------------------------------------------------------------------

def _average_counts(runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Nested counts ({a: {b: n}} or deeper) averaged over the replications
    (a count a replication hasn't got is 0)."""
    keys = {k for r in runs for k in r}
    out: Dict[str, Any] = {}
    for k in keys:
        vals = [r.get(k) for r in runs]
        if any(isinstance(v, dict) for v in vals):
            out[k] = _average_counts([v if isinstance(v, dict) else {} for v in vals])
        else:
            out[k] = sum(v or 0 for v in vals) / len(runs)
    return out


def _average_workers(runs: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Each Worker's worked time, jobs and utilization averaged over the
    replications (a replication it isn't in counts as 0)."""
    n = max(1, len(runs))
    names: List[str] = []
    for workers in runs:
        for w in workers:
            if w["name"] not in names:
                names.append(w["name"])
    out = []
    for name in names:
        rows = [w for workers in runs for w in workers if w["name"] == name]
        places: Dict[str, List[float]] = {}
        for w in rows:
            for p in w.get("workplaces", []):
                at = places.setdefault(p["station"], [0.0, 0.0])
                at[0] += p["worked_time"]
                at[1] += p["jobs"]
        out.append({
            "name": name,
            "worked_time": sum(w["worked_time"] for w in rows) / n,
            "jobs": round(sum(w["jobs"] for w in rows) / n),
            "utilization": sum(w["utilization"] for w in rows) / n,
            "working_pct": sum(w.get("working_pct", 0.0) for w in rows) / n,
            "free_pct": sum(w.get("free_pct", 0.0) for w in rows) / n,
            "available_time": sum(w.get("available_time", 0.0) for w in rows) / n,
            "workplaces": [{"station": st, "worked_time": v[0] / n, "jobs": round(v[1] / n)} for st, v in places.items()],
        })
    return out


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
