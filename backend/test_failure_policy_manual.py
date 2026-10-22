"""
Manual test script for the Failure Policy feature (Resume / Restart / Scrap),
built the same way as the PT/CT/ST-style tests in backend/tests/test_smoke.py:
a tiny 2-3 station line, a short process flow, and plain print() output you
can read directly — not a pytest assertion suite.

Run it from the project root (so `backend` resolves as a package):
    cd C:\\LinkSim\\linksim
    py -3 -m backend.test_failure_policy_manual

IMPORTANT — read this before judging the output:
"Failure rate" is a DAILY failure probability, not a per-job chance, and a
failure can land at any moment — including while the station is simply idle,
waiting for the next job, where there is nothing in progress to Resume/
Restart/Scrap. So even with an aggressive 90% daily failure rate, whether a
single run happens to catch a failure WHILE a part is mid-operation is
genuinely random. That's correct, true-to-life DES behaviour, not a bug.

To make the Scrap/Restart cases reliable to watch instead of "maybe you'll
see it, maybe you won't", _run() below tries a short, fixed list of seeds in
order and reports the FIRST one that actually produces a mid-operation
failure for that station — it prints which seed it used and how many it
tried, so nothing is hidden. If you want to see the raw randomness yourself,
call _run(..., seed=<any number>) directly instead of using run_until_hit().
"""
import random
from backend.engine.sim_core import ManufacturingSimulation

SIM_CONFIG = {
    "SIM_TIME": 480.0 * 30,      # 30 shifts. "Failure rate" is a DAILY
                                 # probability, so a short horizon sees too
                                 # few expected failures to show up reliably.
    "SHIFT_DURATION": 480,
    "SHIFT_1_START": 6, "SHIFT_1_END": 14,
    "SHIFT_2_START": 14, "SHIFT_2_END": 22,
    "SHIFT_3_START": 22, "SHIFT_3_END": 6,
    "STATION_DOWNTIME": 0,
    "ACTIVE_PROCESSING_TIME": 480,
}

# Tried in order by run_until_hit() below — not cherry-picked to fake a
# result, just a short list so the script doesn't hang searching forever.
_CANDIDATE_SEEDS = list(range(20))


def _station(**overrides):
    base = {
        "capacity": 1, "shifts_per_day": 1, "operator_per_station": 1,
        "Failure rate": 0.0, "Repair Time": 10, "PM Schedule": "Monthly",
        "Failure Policy": "resume",
        "Material Shortage Probability (%)": 0, "Rework Probability (%)": 0,
        "shift1": "", "shift2": "", "shift3": "", "STATION_DOWNTIME": 0,
    }
    base.update(overrides)
    return base


def _run(stations, flow, quantities, seed):
    random.seed(seed)
    sim = ManufacturingSimulation(
        stations_data=stations,
        processflow_data=flow,
        variant_quantities=quantities,
        operators_data={},
        simulation_config=SIM_CONFIG,
    )
    return sim.run()


def _scrapped_count(result, station):
    return sum(
        1 for e in result["completion_log"].get(station, [])
        if e.get("status") == "Scrapped"
    )


def run_until_hit(stations_fn, flow, quantities, watch_station):
    """Try each candidate seed until `watch_station` shows at least one
    Scrapped job, or we run out of seeds. Returns (result, seed_used,
    attempts) so the caller can report honestly on what happened."""
    for attempt, seed in enumerate(_CANDIDATE_SEEDS, start=1):
        result = _run(stations_fn(), flow, quantities, seed)
        if _scrapped_count(result, watch_station) > 0:
            return result, seed, attempt
    return result, seed, attempt  # last attempt, even if it never hit


def _report(name, result, station_names, seed_note=""):
    print(f"\n--- {name} ---{seed_note}")
    for s in station_names:
        stats = result["station_stats"].get(s, {})
        completed = stats.get("completed_jobs", 0)
        failures = stats.get("failure_breakdowns", 0)
        scrapped = _scrapped_count(result, s)
        print(f"  {s:12s} completed={completed:4d}  failures={failures:3d}  scrapped={scrapped}")


# ─────────────────────────────────────────────────────────────────────────────
# TEST CASE 1 — Resume (the default)
# 2 stations: A -> B. A fails often but should just pause and continue —
# nothing is ever scrapped under Resume, by definition.
# ─────────────────────────────────────────────────────────────────────────────
def test_case_1_resume():
    stations = {
        "A": _station(**{"Failure rate": 0.9, "Repair Time": 5, "Failure Policy": "resume"}),
        "B": _station(),
    }
    flow = {"part": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "B", "resource": "B", "duration": 10.0},
    ]}
    result = _run(stations, flow, {"part": 150}, seed=0)
    _report("Test 1: RESUME — expect scrapped=0 always (Resume never discards work)",
            result, ["A", "B"])


# ─────────────────────────────────────────────────────────────────────────────
# TEST CASE 2 — Restart
# Same setup, station A set to Restart. Still scrapped=0 always — nothing is
# thrown away, a failed job just redoes its full work after repair.
# ─────────────────────────────────────────────────────────────────────────────
def test_case_2_restart():
    stations = {
        "A": _station(**{"Failure rate": 0.9, "Repair Time": 5, "Failure Policy": "restart"}),
        "B": _station(),
    }
    flow = {"part": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "B", "resource": "B", "duration": 10.0},
    ]}
    result = _run(stations, flow, {"part": 150}, seed=0)
    _report("Test 2: RESTART — expect scrapped=0 always (nothing is thrown away)",
            result, ["A", "B"])


# ─────────────────────────────────────────────────────────────────────────────
# TEST CASE 3 — Scrap
# Same setup, station A set to Scrap. Whether THIS run shows a scrap is
# genuinely random (see module docstring) — run_until_hit() tries a few
# seeds and reports which one actually caught a mid-operation failure.
# ─────────────────────────────────────────────────────────────────────────────
def test_case_3_scrap():
    def build():
        return {
            "A": _station(**{"Failure rate": 0.9, "Repair Time": 5, "Failure Policy": "scrap"}),
            "B": _station(),
        }
    flow = {"part": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "B", "resource": "B", "duration": 10.0},
    ]}
    result, seed, attempts = run_until_hit(build, flow, {"part": 150}, watch_station="A")
    _report(
        "Test 3: SCRAP — expect scrapped > 0 at station A",
        result, ["A", "B"],
        seed_note=f"  (seed={seed}, found on attempt {attempts}/{len(_CANDIDATE_SEEDS)})",
    )


# ─────────────────────────────────────────────────────────────────────────────
# TEST CASE 4 — 3-station line, one policy per station, side by side
# A(resume) -> B(restart) -> C(scrap), all three with the same high failure
# rate. Confirms each station's OWN policy applies independently of the
# others — only C should ever show scrapped > 0.
# ─────────────────────────────────────────────────────────────────────────────
def test_case_4_three_station_mixed():
    def build():
        return {
            "A": _station(**{"Failure rate": 0.9, "Repair Time": 5, "Failure Policy": "resume"}),
            "B": _station(**{"Failure rate": 0.9, "Repair Time": 5, "Failure Policy": "restart"}),
            "C": _station(**{"Failure rate": 0.9, "Repair Time": 5, "Failure Policy": "scrap"}),
        }
    flow = {"part": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "B", "resource": "B", "duration": 10.0},
        {"operation": "C", "resource": "C", "duration": 10.0},
    ]}
    result, seed, attempts = run_until_hit(build, flow, {"part": 150}, watch_station="C")
    _report(
        "Test 4: MIXED — A=resume, B=restart, C=scrap (only C should ever show scrapped > 0)",
        result, ["A", "B", "C"],
        seed_note=f"  (seed={seed}, found on attempt {attempts}/{len(_CANDIDATE_SEEDS)})",
    )


# ─────────────────────────────────────────────────────────────────────────────
# TEST CASE 5 — No Failure Policy set at all (column/field omitted)
# Confirms the default (resume) kicks in automatically, same as before this
# feature existed — nothing special needs to be set for old scenarios.
# ─────────────────────────────────────────────────────────────────────────────
def test_case_5_default_when_unset():
    stations = {
        "A": _station(**{"Failure rate": 0.9, "Repair Time": 5}),
        "B": _station(),
    }
    del stations["A"]["Failure Policy"]  # simulate an old scenario that never had this field
    flow = {"part": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "B", "resource": "B", "duration": 10.0},
    ]}
    result = _run(stations, flow, {"part": 150}, seed=0)
    _report("Test 5: UNSET (old scenario) — expect scrapped=0, behaves like Resume",
            result, ["A", "B"])


if __name__ == "__main__":
    test_case_1_resume()
    test_case_2_restart()
    test_case_3_scrap()
    test_case_4_three_station_mixed()
    test_case_5_default_when_unset()
    print("\nDone. Read each section's 'expect' line and compare against the printed numbers.")
