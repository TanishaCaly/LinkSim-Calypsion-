"""
Statistical analysis per station: the share of its operating time each
machine spent Working, Free, Setup, Blocked and Failed — always 100% in all.

Operating time = the station's shift time (its shifts, working days) minus
breaks and Planned Maintenance; closed hours, breaks and PM are left out.
Within it, each minute is counted once, the first that applies:
  Failed  — broken down / being repaired (its failure log) or STATION_DOWNTIME
  Working — processing a part (rework too)
  Setup   — setup / changeover
  Blocked — a finished part held on it until the next station takes it
  Free    — everything else: no part, waiting for a worker, an Assembly
            waiting for parts, material shortage, operator away.

The job code records the Working / Setup / Blocked / STATION_DOWNTIME
intervals on each SubMachine (state_log); failures and PM come from the
SubMachine's own downtime_log.
"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Tuple

from .sim_utils import SimulationUtils

Interval = Tuple[float, float]

WEEK = 7 * 24 * 60


def new_state_log() -> Dict[str, Any]:
    """A SubMachine's state recording: closed intervals per state, and the
    Blocked intervals still open (start times, by holder)."""
    return {"work": [], "setup": [], "block": [], "fail": [], "open_block": {}}


def record(log: Dict[str, Any], state: str, start: float, end: float) -> None:
    """Add [start, end] to a state_log — joined onto the last interval when it
    carries straight on from it (back-to-back work), so long runs stay small."""
    if end <= start:
        return
    xs = log[state]
    if xs and start <= xs[-1][1] + 1e-9 and start >= xs[-1][0]:
        if end > xs[-1][1]:
            xs[-1] = (xs[-1][0], end)
    else:
        xs.append((start, end))


def merge(intervals: List[Interval]) -> List[Interval]:
    """Sorted, non-overlapping union."""
    out: List[Interval] = []
    for s, e in sorted(i for i in intervals if i[1] > i[0]):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


def subtract(a: List[Interval], b: List[Interval]) -> List[Interval]:
    """a minus b (both merged)."""
    out: List[Interval] = []
    j = 0
    for s, e in a:
        cur = s
        while j < len(b) and b[j][1] <= cur:
            j += 1
        k = j
        while k < len(b) and b[k][0] < e:
            if b[k][0] > cur:
                out.append((cur, b[k][0]))
            cur = max(cur, b[k][1])
            k += 1
        if cur < e:
            out.append((cur, e))
    return out


def overlap(a: List[Interval], b: List[Interval]) -> float:
    """Total length of a ∩ b (both merged)."""
    total = 0.0
    i = j = 0
    while i < len(a) and j < len(b):
        s = max(a[i][0], b[j][0])
        e = min(a[i][1], b[j][1])
        if e > s:
            total += e - s
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


_week_runs_cache: Dict[Any, List[Interval]] = {}


def _week_runs(shift_cfg: Dict[str, Any], shifts_per_day: Any) -> List[Interval]:
    """The station's in-shift minutes of a week (Monday 00:00 = 0), as runs —
    the same minute-by-minute test the processing loop uses (shifts, working
    days, breaks)."""
    key = (repr(sorted((k, repr(v)) for k, v in shift_cfg.items()
                       if k.startswith(("SHIFT_", "WORKING_DAYS_", "BREAKS_", "NUM_SHIFTS")))),
           repr(shifts_per_day))
    runs = _week_runs_cache.get(key)
    if runs is None:
        monday = datetime(2024, 1, 1)  # a Monday
        runs = []
        start = None
        for m in range(WEEK):
            on = SimulationUtils.is_active_shift(shift_cfg, monday + timedelta(minutes=m), shifts_per_day)
            if on and start is None:
                start = m
            elif not on and start is not None:
                runs.append((float(start), float(m)))
                start = None
        if start is not None:
            runs.append((float(start), float(WEEK)))
        _week_runs_cache[key] = runs
    return runs


def shift_time(shift_cfg: Dict[str, Any], shifts_per_day: Any, start_date: datetime, end: float) -> List[Interval]:
    """The station's in-shift time over [0, end] (minutes since start_date)."""
    runs = _week_runs(shift_cfg, shifts_per_day)
    offset = (start_date.weekday() * 1440 + start_date.hour * 60 + start_date.minute
              + start_date.second / 60.0)
    out: List[Interval] = []
    week = 0
    while week * WEEK - offset < end:
        base = week * WEEK - offset
        for s, e in runs:
            a, b = max(0.0, base + s), min(end, base + e)
            if b > a:
                out.append((a, b))
        week += 1
    return merge(out)


def machine_intervals(sm: Any, end: float) -> Dict[str, List[Interval]]:
    """One SubMachine's merged intervals per state, cut at `end`; Failed
    first, then each state without the ones before it."""
    log = getattr(sm, "state_log", None) or new_state_log()
    cut = lambda xs: merge([(s, min(e, end)) for s, e in xs if s < end])
    fail = list(log["fail"])
    pm: List[Interval] = []
    for kind, s, e, _d in getattr(sm, "downtime_log", []):
        (pm if kind == "Maintenance" else fail).append((s, e))
    if getattr(sm, "failure_start_time", None) is not None:
        fail.append((sm.failure_start_time, end))
    if getattr(sm, "pm_start_time", None) is not None:
        pm.append((sm.pm_start_time, end))
    block = list(log["block"]) + [(s, end) for s in log["open_block"].values()]
    failed = cut(fail)
    working = subtract(cut(log["work"]), failed)
    setup = subtract(subtract(cut(log["setup"]), failed), working)
    blocked = subtract(subtract(subtract(cut(block), failed), working), setup)
    return {"pm": cut(pm), "failed": failed, "working": working, "setup": setup, "blocked": blocked}


def station_states(sub_machines: List[Any], shift_cfg: Dict[str, Any], shifts_per_day: Any,
                   start_date: datetime, end: float, start: float = 0.0) -> Dict[str, float]:
    """A station's Working / Free / Setup / Blocked / Failed percentages of
    its operating time between `start` (the warm-up's end) and `end` (all its
    machines together), and that time (min, per machine)."""
    shifts = shift_time(shift_cfg, shifts_per_day, start_date, end)
    if start > 0:
        shifts = subtract(shifts, [(0.0, start)])
    totals = {"working": 0.0, "setup": 0.0, "blocked": 0.0, "failed": 0.0}
    operating_total = 0.0
    for sm in sub_machines:
        iv = machine_intervals(sm, end)
        operating = subtract(shifts, iv["pm"])
        operating_total += sum(e - s for s, e in operating)
        for state in totals:
            totals[state] += overlap(iv[state], operating)
    if operating_total <= 0:
        return {"working": 0.0, "free": 0.0, "setup": 0.0, "blocked": 0.0, "failed": 0.0, "operating_time": 0.0}
    pct = {state: t / operating_total * 100.0 for state, t in totals.items()}
    pct["free"] = max(0.0, 100.0 - sum(pct.values()))
    return {**pct, "operating_time": operating_total / max(1, len(sub_machines))}


def buffer_states(occupied: List[Interval], full: List[Interval], shift_cfg: Dict[str, Any],
                  shifts_per_day: Any, start_date: datetime, end: float, start: float = 0.0) -> Dict[str, float]:
    """A Buffer's Empty / Occupied (some parts, room for more) / Full
    percentages of its operating time (shift time minus breaks, after the
    warm-up — like a station's), and that time (min)."""
    shifts = shift_time(shift_cfg, shifts_per_day, start_date, end)
    if start > 0:
        shifts = subtract(shifts, [(0.0, start)])
    total = sum(e - s for s, e in shifts)
    if total <= 0:
        return {"empty": 0.0, "occupied": 0.0, "full": 0.0, "operating_time": 0.0}
    cut = lambda xs: merge([(s, min(e, end)) for s, e in xs if s < end])
    full_iv = cut(full)
    occ_iv = subtract(cut(occupied), full_iv)
    pct = {"occupied": overlap(occ_iv, shifts) / total * 100.0, "full": overlap(full_iv, shifts) / total * 100.0}
    pct["empty"] = max(0.0, 100.0 - pct["occupied"] - pct["full"])
    return {**pct, "operating_time": total}
