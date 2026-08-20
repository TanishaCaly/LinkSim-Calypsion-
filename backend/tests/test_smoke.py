"""
Smoke + regression tests for the LinkSim engine.

Guards:
  - the bundled template must produce a working simulation (non-zero throughput)
  - no "Negative delay" crashes abort operations mid-line
  - each station's own shift windows are honoured (#3)
  - multi-replication runs keep their bottleneck data (#6)
"""
import random
from pathlib import Path

import pytest

from backend.parsers.excel_parser import ExcelParser
from backend.engine.sim_core import ManufacturingSimulation
from backend.engine.sim_utils import SimulationUtils

# Repo layout: linksim/backend/tests/test_smoke.py  ->  Sim App/LinkSim_Template.xlsx
TEMPLATE = Path(__file__).resolve().parents[3] / "LinkSim_Template.xlsx"

# One year, three shifts - matches the default config used by the app.
SIM_CONFIG = {
    "SIM_TIME": 525600.0,
    "SHIFT_DURATION": 480.0,
    "SHIFT_1_START": 6.0, "SHIFT_1_END": 14.0,
    "SHIFT_2_START": 14.0, "SHIFT_2_END": 22.0,
    "SHIFT_3_START": 22.0, "SHIFT_3_END": 6.0,
    "STATION_DOWNTIME": 0,
    "ACTIVE_PROCESSING_TIME": 480,
}


@pytest.fixture(scope="module")
def parsed_template():
    if not TEMPLATE.exists():
        pytest.skip(f"Template not found at {TEMPLATE}")
    return ExcelParser().parse_all(str(TEMPLATE))


def _run(parsed, quantities):
    random.seed(42)
    sim = ManufacturingSimulation(
        stations_data=parsed["stations"],
        processflow_data=parsed["processflow"],
        variant_quantities=quantities,
        operators_data=parsed["operators"],
        simulation_config=dict(SIM_CONFIG),
    )
    return sim.run()


def test_template_parses(parsed_template):
    assert parsed_template["stations"], "no stations parsed from template"
    assert parsed_template["processflow"], "no process flow parsed from template"


def test_template_produces_nonzero_throughput(parsed_template):
    """Core regression guard: the line must actually complete jobs."""
    result = _run(parsed_template, {"variant1": 5})

    completed = result["simulation_state"]["completed_jobs"]
    assert completed > 0, (
        f"Expected completed_jobs > 0 but got {completed}. "
        "Jobs are stalling somewhere in the line (operator / shift gating)."
    )

    station_jobs = sum(
        s.get("completed_jobs", 0) for s in result["station_stats"].values()
    )
    assert station_jobs > 0, "no station recorded any completed jobs"

    any_busy = any(
        s.get("station_utilization", 0) > 0 for s in result["station_stats"].values()
    )
    assert any_busy, "every station reported 0% utilization"


def test_run_does_not_raise_negative_delay(parsed_template):
    """
    Stations with failures/PM must not crash the operation with SimPy's
    'Negative delay' (the station-downtime-budget clamp). A clean run keeps
    per-station completions intact.
    """
    result = _run(parsed_template, {"variant1": 3})
    n_stations = len(result["station_stats"])
    station_jobs = sum(
        s.get("completed_jobs", 0) for s in result["station_stats"].values()
    )
    assert station_jobs >= 2 * n_stations, (
        f"only {station_jobs} station-completions for 3 jobs across "
        f"{n_stations} stations - operations are being aborted"
    )


# ---------------------------------------------------------------------------
# #3 - per-station shift hours must be honoured (not just the global config)
# ---------------------------------------------------------------------------

def test_parse_shift_window():
    assert SimulationUtils.parse_shift_window("08:00-16:00") == (8.0, 16.0)
    # "00:00" end means midnight / end of day -> 24.0
    assert SimulationUtils.parse_shift_window("16:00-00:00") == (16.0, 24.0)
    assert SimulationUtils.parse_shift_window("06:30-14:30") == (6.5, 14.5)
    # blanks / junk -> None (fall back to global config)
    for bad in (None, "", "nan", "-", "not a window", "0"):
        assert SimulationUtils.parse_shift_window(bad) is None


def test_build_station_shift_config_overrides_and_falls_back():
    base = dict(SIM_CONFIG)
    station = {"shift1": "08:00-16:00", "shift2": "16:00-00:00", "shift3": "nan"}
    cfg = SimulationUtils.build_station_shift_config(base, station)
    # station windows override global
    assert cfg["SHIFT_1_START"] == 8.0 and cfg["SHIFT_1_END"] == 16.0
    assert cfg["SHIFT_2_START"] == 16.0 and cfg["SHIFT_2_END"] == 24.0
    # shift3 was invalid -> keep global value, don't clobber
    assert cfg["SHIFT_3_START"] == base["SHIFT_3_START"]
    # base config is not mutated
    assert base["SHIFT_1_END"] == SIM_CONFIG["SHIFT_1_END"]


def test_engine_uses_per_station_shift_windows(parsed_template):
    """The engine must build per-station shift configs from the station data."""
    sim = ManufacturingSimulation(
        stations_data=parsed_template["stations"],
        processflow_data=parsed_template["processflow"],
        variant_quantities={"variant1": 1},
        operators_data=parsed_template["operators"],
        simulation_config=dict(SIM_CONFIG),
    )
    sim.run()
    # ATA's sheet shifts are 08:00-16:00 / 16:00-00:00 - the effective config
    # must reflect those, NOT the global 6.0 / 22.0 defaults.
    ata_cfg = sim._station_shift_cfg["ATA"]
    assert ata_cfg["SHIFT_1_START"] == 8.0
    assert ata_cfg["SHIFT_2_END"] == 24.0
    assert ata_cfg["SHIFT_1_START"] != SIM_CONFIG["SHIFT_1_START"]


# ---------------------------------------------------------------------------
# #6 - multi-replication runs must keep bottleneck data
# ---------------------------------------------------------------------------

def test_multirep_preserves_bottleneck_data(parsed_template):
    random.seed(42)
    sim = ManufacturingSimulation(
        stations_data=parsed_template["stations"],
        processflow_data=parsed_template["processflow"],
        variant_quantities={"variant1": 4},
        operators_data=parsed_template["operators"],
        simulation_config=dict(SIM_CONFIG),
    )
    result = sim.run_with_replications(num_replications=3)

    bn = result.get("bottleneck_store")
    assert bn, "multi-rep result dropped bottleneck_store"
    # at least one station carries a usable top bottleneck (type present),
    # which is exactly what crud.complete_run persists per StationStat row.
    has_typed = any(
        (info.get("bottlenecks") or [{}])[0].get("type")
        for info in bn.values()
    )
    assert has_typed, "no station has a typed top bottleneck after aggregation"


# ---------------------------------------------------------------------------
# #7 - stations with 0 operators are machine-only and must not gate on operators
# ---------------------------------------------------------------------------

def _tiny_scenario(operator_per_station, availability):
    stations = {
        "Q": {
            "capacity": 1, "shifts_per_day": 1,
            "operator_per_station": operator_per_station,
            "Failure rate": 0.0, "Repair Time": 10, "PM Schedule": "nan",
            "Material Shortage Probability (%)": 0, "Rework Probability (%)": 0,
            # shift1 names a *real* operator so resolve_assigned_operators would
            # otherwise gate on it; availability controls whether it's free.
            "shift1": "OP1", "shift2": "nan", "shift3": "nan",
            "STATION_DOWNTIME": 0,
        }
    }
    operators = {"OP1": {"Skill Rating": 1.0, "Availability (%)": availability}}
    flow = {"v": [{"operation": "Q", "resource": "Q", "duration": 10.0}]}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0  # one shift - fast regardless of outcome
    return stations, operators, flow, cfg


def test_zero_operator_station_does_not_gate():
    # 0 operators + an operator that is never available (0%). If the station
    # gated on operators it would deadlock and complete 0 jobs; it must not.
    stations, operators, flow, cfg = _tiny_scenario(operator_per_station=0, availability=0.0)
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, {"v": 1}, operators, cfg)
    result = sim.run()
    assert result["simulation_state"]["completed_jobs"] == 1, (
        "a machine-only (0-operator) station should process without an operator"
    )


def test_operator_gating_still_applies_when_operators_present():
    # Contrast: WITH an operator assigned (count=1) but 0% availability, the
    # station correctly waits and the job cannot finish within one shift.
    stations, operators, flow, cfg = _tiny_scenario(operator_per_station=1, availability=0.0)
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, {"v": 1}, operators, cfg)
    result = sim.run()
    assert result["simulation_state"]["completed_jobs"] == 0, (
        "an unavailable assigned operator should still block processing"
    )


# ---------------------------------------------------------------------------
# #8 - SIM_TIME guardrail: reject invalid, clamp runaway horizons
# ---------------------------------------------------------------------------

def _one_station_sim(sim_time):
    stations = {"Q": {"capacity": 1, "shifts_per_day": 1, "operator_per_station": 0,
                      "Failure rate": 0.0, "Repair Time": 10, "PM Schedule": "nan",
                      "shift1": "nan", "shift2": "nan", "shift3": "nan", "STATION_DOWNTIME": 0}}
    flow = {"v": [{"operation": "Q", "resource": "Q", "duration": 5.0}]}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = sim_time
    return ManufacturingSimulation(stations, flow, {"v": 1}, {}, cfg)


@pytest.mark.parametrize("bad", [0, -100, "abc", float("inf"), float("nan")])
def test_invalid_sim_time_raises(bad):
    with pytest.raises(ValueError):
        _one_station_sim(bad).run()


def test_runaway_sim_time_is_clamped():
    from backend.engine.sim_core import MAX_SIM_TIME
    sim = _one_station_sim(MAX_SIM_TIME * 100)
    sim.run()
    assert sim.sim_config["SIM_TIME"] == MAX_SIM_TIME


# ---------------------------------------------------------------------------
# Station Type behaviours: Connector (instant pass-through) and
# Conveyor (transport delay, no operator, unbounded concurrency)
# ---------------------------------------------------------------------------

def _station(**overrides):
    base = {
        "capacity": 1, "shifts_per_day": 1, "operator_per_station": 1,
        "Failure rate": 0.0, "Repair Time": 10, "PM Schedule": "nan",
        "Material Shortage Probability (%)": 0, "Rework Probability (%)": 0,
        "shift1": "nan", "shift2": "nan", "shift3": "nan", "STATION_DOWNTIME": 0,
    }
    base.update(overrides)
    return base


def _run_sim(stations, flow, quantities, operators=None, sim_time=480.0):
    """Run a sim and return (result, sim) — per-station counters live on `sim`."""
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = sim_time
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, quantities, operators or {}, cfg)
    return sim.run(), sim


def _last_job_end(result):
    """When the final job left the line (not the sim horizon)."""
    return max(result["simulation_state"]["job_exit_times"].values())


def test_connector_passes_through_with_zero_time():
    # A -> C(onnector) -> B. The connector must add no time at all, so the job
    # is done after A + B only, and it must still appear in the job trace.
    stations = {
        "A": _station(operator_per_station=0),
        "C": _station(operator_per_station=0, **{"Station Type": "Connector"}),
        "B": _station(operator_per_station=0),
    }
    flow = {"v": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "C", "resource": "C", "duration": 999.0},  # must be ignored
        {"operation": "B", "resource": "B", "duration": 10.0},
    ]}
    result, sim = _run_sim(stations, flow, {"v": 1})

    assert result["simulation_state"]["completed_jobs"] == 1
    # The connector's 999-minute "duration" must never have been served —
    # A (10) + B (10) only.
    assert _last_job_end(result) == pytest.approx(20.0)
    conn = sim.stations_data["C"]
    assert conn.get("busy_time", 0) == 0, "a connector must not accumulate busy time"
    assert conn.get("total_setup_time", 0) == 0
    assert conn.get("total_rework_time", 0) == 0
    # Still visible in the trace rather than silently dropped.
    trace = result["completion_log"]["C"]
    assert len(trace) == 1 and trace[0]["status"] == "Completed"
    assert trace[0]["Processing Time"] == 0.0


def test_conveyor_uses_transport_time_and_needs_no_operator():
    # The conveyor names a real operator who is never available. A machine
    # would stall; a conveyor must run regardless, for its Transport Time.
    stations = {
        "BELT": _station(
            operator_per_station=1, shift1="OP1",
            **{"Station Type": "Conveyor", "Transport Time": 7.0},
        ),
    }
    operators = {"OP1": {"Skill Rating": 1.0, "Availability (%)": 0.0}}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    result, sim = _run_sim(stations, flow, {"v": 1}, operators)

    assert result["simulation_state"]["completed_jobs"] == 1, (
        "a conveyor must not wait for an operator"
    )
    # Transport Time (7) wins over the step duration (99), and is NOT divided
    # by the operator count the way a machine's cycle time would be.
    assert sim.stations_data["BELT"]["busy_time"] == pytest.approx(7.0)
    assert _last_job_end(result) == pytest.approx(7.0)


def test_conveyor_carries_jobs_concurrently():
    # Ten jobs on a belt configured with capacity 1. A machine would serialise
    # them (last one done at t=50); a belt carries them all at once, so every
    # job is off the belt after a single transport time.
    stations = {
        "BELT": _station(
            capacity=1, operator_per_station=0,
            **{"Station Type": "Conveyor", "Transport Time": 5.0},
        ),
    }
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 10})

    assert result["simulation_state"]["completed_jobs"] == 10
    assert _last_job_end(result) == pytest.approx(5.0), (
        "jobs queued one-at-a-time instead of riding the belt together"
    )


# ---------------------------------------------------------------------------
# Worker / Worker Controller: zero-time passthrough (like Connector). The
# "Min Skill Rating" tests below exercise operator_available's older static
# shift1/2/3 skill gate directly — unrelated to the live WorkerPool further
# down, which does not (yet) have a skill concept (see worker_pool.py).
# ---------------------------------------------------------------------------

def test_worker_and_worker_controller_pass_through_with_zero_time():
    # A -> Worker -> WorkerController -> B. Neither annotation node may add
    # any time or ever be waited on for an operator.
    stations = {
        "A":  _station(operator_per_station=0),
        "W":  _station(operator_per_station=0, **{"Station Type": "Worker"}),
        "WC": _station(operator_per_station=0, **{"Station Type": "Worker Controller"}),
        "B":  _station(operator_per_station=0),
    }
    flow = {"v": [
        {"operation": "A", "resource": "A", "duration": 10.0},
        {"operation": "W", "resource": "W", "duration": 999.0},
        {"operation": "WC", "resource": "WC", "duration": 999.0},
        {"operation": "B", "resource": "B", "duration": 10.0},
    ]}
    result, sim = _run_sim(stations, flow, {"v": 1})

    assert result["simulation_state"]["completed_jobs"] == 1
    assert _last_job_end(result) == pytest.approx(20.0)
    for name in ("W", "WC"):
        st = sim.stations_data[name]
        assert st.get("busy_time", 0) == 0, f"{name} must not accumulate busy time"


def test_min_skill_rating_rejects_underskilled_operator():
    # Same operator, same availability (100%) — only "Min Skill Rating"
    # differs between the two stations. The low-skill operator must be
    # rejected at the gated station (falls back to no-operator behaviour:
    # operator_available returns None) but accepted at the ungated one.
    stations_data = {
        "GATED":    {"shift1": "OP1"},
        "UNGATED":  {"shift1": "OP1"},
    }
    stations_data["GATED"]["Min Skill Rating"] = 5
    operators_data = {"OP1": {"Skill Rating": 3, "Availability (%)": 100}}

    gated = SimulationUtils.operator_available(stations_data, operators_data, "GATED", current_shift=1)
    ungated = SimulationUtils.operator_available(stations_data, operators_data, "UNGATED", current_shift=1)

    assert gated is None, "an operator below the Min Skill Rating must be rejected"
    assert ungated == [("OP1", 3)], "the same operator must pass where no skill gate is set"


def test_min_skill_rating_accepts_operator_meeting_threshold():
    stations_data = {"GATED": {"shift1": "OP1", "Min Skill Rating": 5}}
    operators_data = {"OP1": {"Skill Rating": 5, "Availability (%)": 100}}

    result = SimulationUtils.operator_available(stations_data, operators_data, "GATED", current_shift=1)
    assert result == [("OP1", 5)], "an operator meeting the threshold exactly must be accepted"


# ---------------------------------------------------------------------------
# Worker Controller pool: a live shared pool of Workers dispatched to real
# stations that name this Controller via "Worker Controller" (distinct from
# the static shift1/2/3 assignment above — see worker_pool.py). Most tests
# below name the Controller directly on the "station" for brevity — the
# Workplace passthrough that actually wires this on canvas is exercised
# separately in test_workplace_is_a_zero_time_side_annotation_for_a_real_station.
# ---------------------------------------------------------------------------

def _pool_worker(name="W1", availability=100.0, travel_time=0.0):
    return {"name": name, "availability": availability, "travel_time": travel_time}


def test_two_workplaces_share_one_worker_and_serialise():
    # WP_A and WP_B both name the same Controller, which has exactly ONE
    # Worker in its pool. Two jobs, one at each Workplace, both wanting that
    # worker at t=0 — they must serialise (one waits for the other to finish
    # and release the worker) rather than both proceeding simultaneously.
    stations = {
        "WP_A": _station(operator_per_station=1, **{
            "Worker Controller": "WC",
        }),
        "WP_B": _station(operator_per_station=1, **{
            "Worker Controller": "WC",
        }),
        "WC": _station(operator_per_station=0, **{
            "Station Type": "Worker Controller",
            "Pool Workers": [_pool_worker()],
        }),
    }
    flow_a = {"a": [{"operation": "A", "resource": "WP_A", "duration": 10.0}]}
    flow_b = {"b": [{"operation": "B", "resource": "WP_B", "duration": 10.0}]}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    random.seed(0)
    sim = ManufacturingSimulation(
        {**stations}, {**flow_a, **flow_b}, {"a": 1, "b": 1}, {}, cfg,
    )
    result = sim.run()

    assert result["simulation_state"]["completed_jobs"] == 2
    # One worker, two 10-minute jobs: the second can't start until the first
    # releases the worker, so total elapsed must be 20 minutes, not 10.
    assert _last_job_end(result) == pytest.approx(20.0), (
        "both Workplaces must NOT be able to use the same pooled Worker at once"
    )


def test_travel_time_charged_only_on_reassignment():
    # Same worker, same job twice in a row at the SAME Workplace: no travel
    # time the second time (last_workplace already matches). A third job at
    # a DIFFERENT Workplace sharing the same pool DOES pay travel time.
    stations = {
        "WP_A": _station(operator_per_station=1, **{
            "Worker Controller": "WC",
        }),
        "WP_B": _station(operator_per_station=1, **{
            "Worker Controller": "WC",
        }),
        "WC": _station(operator_per_station=0, **{
            "Station Type": "Worker Controller",
            "Pool Workers": [_pool_worker(travel_time=15.0)],
        }),
    }
    # Two jobs at WP_A back-to-back (no reassignment), sequenced so the
    # second only starts once the first has released the worker.
    flow_same = {"a": [
        {"operation": "A1", "resource": "WP_A", "duration": 5.0},
    ]}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    random.seed(0)
    sim_same = ManufacturingSimulation(stations, flow_same, {"a": 2}, {}, cfg)
    result_same = sim_same.run()
    # Two 5-minute jobs, same Workplace both times, one worker: no travel
    # time ever charged, so total elapsed is exactly 10 (5 + 5).
    assert _last_job_end(result_same) == pytest.approx(10.0), (
        "staying at the same Workplace must not charge travel time"
    )

    # One job at WP_A, then one at WP_B — the worker must travel between them.
    flow_switch = {
        "a": [{"operation": "A1", "resource": "WP_A", "duration": 5.0}],
        "b": [{"operation": "B1", "resource": "WP_B", "duration": 5.0}],
    }
    random.seed(0)
    sim_switch = ManufacturingSimulation(
        {k: dict(v) for k, v in stations.items()}, flow_switch, {"a": 1, "b": 1}, {}, cfg,
    )
    result_switch = sim_switch.run()
    assert result_switch["simulation_state"]["completed_jobs"] == 2
    # Both jobs spawn at t=0; only one Worker exists, so whichever job goes
    # second must wait for the first (5) AND pay travel time (15) before its
    # own 5-minute cycle time — 5 + 15 + 5 = 25 total elapsed.
    assert _last_job_end(result_switch) == pytest.approx(25.0), (
        "reassigning the pooled Worker to a different Workplace must charge its Travel Time"
    )


def test_round_robin_dispatches_every_worker_at_once():
    # Three Workplaces sharing a Controller with three Workers, all firing at
    # t=0. Round Robin (with all workers free) must dispatch all three
    # immediately — one worker each — not serialise them one at a time.
    stations = {
        "WP_A": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP_B": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP_C": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WC": _station(operator_per_station=0, **{
            "Station Type": "Worker Controller",
            "Assignment Strategy": "round_robin",
            "Pool Workers": [_pool_worker("W1"), _pool_worker("W2"), _pool_worker("W3")],
        }),
    }
    flow = {
        "a": [{"operation": "A", "resource": "WP_A", "duration": 5.0}],
        "b": [{"operation": "B", "resource": "WP_B", "duration": 5.0}],
        "c": [{"operation": "C", "resource": "WP_C", "duration": 5.0}],
    }
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, {"a": 1, "b": 1, "c": 1}, {}, cfg)
    result = sim.run()

    assert result["simulation_state"]["completed_jobs"] == 3
    # All three workers free at t=0 — every job must finish at t=5, not
    # serialised one-at-a-time (which would end at 5/10/15).
    assert _last_job_end(result) == pytest.approx(5.0), (
        "round robin with enough free workers must dispatch all requests immediately"
    )
    pool = sim.worker_pools["WC"]
    assigned = {w.last_workplace for w in pool.workers}
    assert assigned == {"WP_A", "WP_B", "WP_C"}, "each worker must have gone to a different Workplace"


def test_queue_policy_reject_drops_job_when_queue_full():
    # A single-worker pool with Queue Policy "reject" and Max Queue Size 1.
    # Two simultaneous requests: the queue can only hold 1, so one job must
    # be rejected outright rather than waiting.
    stations = {
        "WP_A": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP_B": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WC": _station(operator_per_station=0, **{
            "Station Type": "Worker Controller",
            "Queue Policy": "reject",
            "Max Queue Size": 1,
            "Pool Workers": [_pool_worker()],
        }),
    }
    flow = {
        "a": [{"operation": "A", "resource": "WP_A", "duration": 5.0}],
        "b": [{"operation": "B", "resource": "WP_B", "duration": 5.0}],
    }
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, {"a": 1, "b": 1}, {}, cfg)
    result = sim.run()

    assert result["simulation_state"]["completed_jobs"] == 1, "exactly one job must complete"
    assert result["simulation_state"]["rejected_jobs"] == 1, "exactly one job must be rejected"
    rejected_traces = [
        e for log in result["completion_log"].values() for e in log if e.get("status") == "Rejected"
    ]
    assert len(rejected_traces) == 1, "the rejected job must still appear in the job trace, not vanish"


def test_workplace_is_a_zero_time_side_annotation_for_a_real_station():
    # The current model: Workplace is NOT itself a work station — it's a
    # side-annotation Canvas wires between a REAL station and a Worker
    # Controller (Station -> Workplace -> Worker Controller). The REAL
    # station is what names "Worker Controller" and draws from the pool; the
    # Workplace station entry itself, if it ever reached _perform_operation,
    # must behave like Connector (zero busy time) — it never should reach it
    # at all in a real Canvas-built scenario, but the type itself must still
    # be recognised as a passthrough for safety/consistency (_is_passthrough).
    stations = {
        "REAL": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP":   _station(operator_per_station=0, **{"Station Type": "Workplace"}),
        "WC":   _station(operator_per_station=0, **{
            "Station Type": "Worker Controller",
            "Pool Workers": [_pool_worker()],
        }),
    }
    flow = {"v": [{"operation": "V", "resource": "REAL", "duration": 5.0}]}
    result, sim = _run_sim(stations, flow, {"v": 1})

    assert result["simulation_state"]["completed_jobs"] == 1
    # The real station actually drew from the pool — proof the "Worker
    # Controller" field on the REAL station (not on WP) is what the engine
    # keys off.
    pool = sim.worker_pools["WC"]
    assert pool.workers[0].last_workplace == "REAL", (
        "the real station must be the one recorded as the Worker's last workplace"
    )
    from backend.engine.sim_core import _is_passthrough
    assert _is_passthrough(stations["WP"]), "Workplace must be recognised as a zero-time passthrough type"


def test_multi_replication_keeps_rejected_jobs_and_worker_pool_stats():
    # Regression guard: _aggregate_replications previously had no
    # "rejected_jobs" key in its simulation_state, and no "worker_pool_stats"
    # key in its return value at all — a scenario using a rejecting pool
    # would silently show 0 rejections / "no pool data" the moment more than
    # one replication was run, even though a single run reported both fields.
    stations = {
        "WP_A": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP_B": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WC": _station(operator_per_station=0, **{
            "Station Type": "Worker Controller",
            "Queue Policy": "reject",
            "Max Queue Size": 1,
            "Pool Workers": [_pool_worker()],
        }),
    }
    flow = {
        "a": [{"operation": "A", "resource": "WP_A", "duration": 5.0}],
        "b": [{"operation": "B", "resource": "WP_B", "duration": 5.0}],
    }
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    sim = ManufacturingSimulation(stations, flow, {"a": 1, "b": 1}, {}, cfg)
    result = sim.run_with_replications(num_replications=3)

    assert result["simulation_state"]["rejected_jobs"] >= 1, (
        "rejected_jobs must survive multi-replication aggregation, not silently drop to 0"
    )
    assert "WC" in result["worker_pool_stats"], (
        "worker_pool_stats must survive multi-replication aggregation, not be dropped entirely"
    )
    wc_stats = result["worker_pool_stats"]["WC"]
    assert wc_stats["jobs_completed"] >= 1
    assert wc_stats["jobs_rejected"] >= 1


# ---------------------------------------------------------------------------
# Excel import for the Worker Controller pool feature: a "Worker Controllers"
# sheet (Controller, Worker, Worker Availability (%), Worker Travel Time,
# Assignment Strategy, Queue Policy, Max Queue Size, ...) — one row per pool
# worker — merges Pool Workers/dispatch settings into that controller's own
# stations_data entry, and the Stations sheet's "Worker Controller" column
# names which controller a real station draws from (see excel_parser.py).
# ---------------------------------------------------------------------------

def _build_workbook(stations_rows, worker_controller_rows=None):
    import io
    import pandas as pd
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        pd.DataFrame(stations_rows).to_excel(writer, sheet_name="Stations", index=False)
        if worker_controller_rows is not None:
            pd.DataFrame(worker_controller_rows).to_excel(writer, sheet_name="Worker Controllers", index=False)
    buf.seek(0)
    return buf.read()


def test_excel_worker_controllers_sheet_merges_into_stations_data():
    workbook = _build_workbook(
        stations_rows=[{"Station": "REAL", "Capacity": 1, "Worker Controller": "WC1"}],
        worker_controller_rows=[
            {
                "Controller": "WC1", "Worker": "W1",
                "Worker Availability (%)": 90, "Worker Travel Time": 5,
                "Assignment Strategy": "round_robin", "Queue Policy": "queue", "Max Queue Size": 10,
            },
            {"Controller": "WC1", "Worker": "W2", "Worker Availability (%)": 100, "Worker Travel Time": 15},
        ],
    )
    parsed = ExcelParser().parse_all(workbook)
    stations = parsed["stations"]

    assert stations["REAL"]["Worker Controller"] == "WC1"
    wc = stations["WC1"]
    assert wc["Station Type"] == "Worker Controller", (
        "a controller only ever named in the Worker Controllers sheet must still get a "
        "Worker Controller-typed stations_data entry, even with no matching Stations row"
    )
    assert wc["Assignment Strategy"] == "round_robin"
    assert wc["Queue Policy"] == "queue"
    assert wc["Max Queue Size"] == 10
    assert wc["Pool Workers"] == [
        {"name": "W1", "availability": 90.0, "travel_time": 5.0},
        {"name": "W2", "availability": 100.0, "travel_time": 15.0},
    ]


def test_excel_imported_worker_controller_pool_actually_gates_processing():
    # End-to-end: the parsed workbook must feed a live pool the engine
    # actually dispatches from — not just a correctly-shaped dict.
    workbook = _build_workbook(
        stations_rows=[{"Station": "REAL", "Capacity": 1, "operator_per_station": 1, "Worker Controller": "WC1"}],
        worker_controller_rows=[
            {"Controller": "WC1", "Worker": "W1", "Worker Availability (%)": 100, "Worker Travel Time": 0},
        ],
    )
    parsed = ExcelParser().parse_all(workbook)
    flow = {"v": [{"operation": "V", "resource": "REAL", "duration": 5.0}]}
    result, sim = _run_sim(parsed["stations"], flow, {"v": 1})

    assert result["simulation_state"]["completed_jobs"] == 1
    assert sim.worker_pools["WC1"].workers[0].last_workplace == "REAL", (
        "an Excel-imported Worker Controller pool must actually dispatch to the real station"
    )


def test_excel_station_type_and_worker_controller_columns_are_optional():
    # Every pre-existing Excel scenario has neither column — must not break
    # or change behaviour for a station with no Station Type/Worker Controller.
    workbook = _build_workbook(stations_rows=[{"Station": "PLAIN", "Capacity": 1}])
    parsed = ExcelParser().parse_all(workbook)
    plain = parsed["stations"]["PLAIN"]
    assert plain["Station Type"] == ""
    assert plain["Worker Controller"] == ""


def test_yaml_stations_already_pass_through_worker_controller_fields():
    # Unlike Excel/CSV (which need an explicit column mapping — see
    # excel_parser.py's Worker Controllers sheet), YamlParser.parse_stations
    # is schema-free passthrough: whatever keys a user writes inline under a
    # station already flow straight through with zero parser changes needed.
    # This guards that passthrough behaviour against a future refactor.
    from backend.parsers.yaml_parser import YamlParser
    yaml_text = """
stations:
  REAL:
    capacity: 1
    operator_per_station: 1
    Worker Controller: WC1
  WC1:
    Station Type: Worker Controller
    Pool Workers:
      - name: W1
        availability: 100
        travel_time: 0
"""
    result = YamlParser().parse_stations(yaml_text)
    assert result["REAL"]["Worker Controller"] == "WC1"
    assert result["WC1"]["Station Type"] == "Worker Controller"
    assert result["WC1"]["Pool Workers"] == [{"name": "W1", "availability": 100, "travel_time": 0}]


def test_untyped_station_still_behaves_as_a_machine():
    # Regression guard: a station with no "Station Type" (every imported
    # scenario) must keep serialising jobs through its single server.
    stations = {"M": _station(capacity=1, operator_per_station=0)}
    flow = {"v": [{"operation": "M", "resource": "M", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 3})

    assert result["simulation_state"]["completed_jobs"] == 3
    # Three jobs, one server, 5 minutes each — the last one ends at 15.
    assert _last_job_end(result) == pytest.approx(15.0)


def test_list_shifts_per_day_does_not_crash_bottleneck_analysis():
    # Regression guard: every Canvas-built scenario saves shifts_per_day as
    # an explicit list of active shift numbers (e.g. [1, 2]), not the legacy
    # int count — identify_bottlenecks/calculate_affected_jobs used it
    # directly as a numeric multiplier (`improvement * ... * shifts_per_day
    # * ...`), which raises "can't multiply sequence by non-int of type
    # 'float'" the moment a list reaches that math. This previously surfaced
    # as a run outright FAILING in _post_process for any scenario built
    # through Canvas whose station triggered the operator_availability
    # bottleneck branch — not just an inaccurate stat.
    #
    # Unit-tested directly against a hand-built station_info dict (rather
    # than tuning a full ManufacturingSimulation run to organically produce
    # avg_block_time > 240) so the crashing branch is reached deterministically.
    from backend.engine.bottleneck import identify_bottlenecks, calculate_affected_jobs

    station_info = {
        "shifts_per_day": [1, 2],  # the list form that used to crash
        "avg_block_time": 500,  # > 240, clears the early-return guard
        "busy_time": 1000,
        "capacity": 1,
        "operator_per_station": 1,
        "completed_jobs_per_station": 50,
        "completed_jobs": 50,
        "total_simulated_time_per_station": 480 * 30,
        "buffer_blocked_ratio": 0,
        "Failure rate": 0,
        "shift1": "OP1", "shift2": "OP1", "shift3": "",
    }
    operators_data = {"OP1": {"Skill Rating": 3.0, "Availability (%)": 50.0}}  # < 100 triggers the crashing branch
    sim_config = {"SIM_TIME": 480 * 30, "SHIFT_DURATION": 480, "total_days": 30}
    cycle_times = {"M": 5.0}

    bottlenecks = identify_bottlenecks("M", station_info, operators_data, sim_config, cycle_times)
    assert any(b["type"] == "operator_availability" for b in bottlenecks), (
        "expected the operator_availability branch (the one that used to crash) to actually fire"
    )

    affected = calculate_affected_jobs("M", station_info, sim_config, cycle_times)
    assert affected["station"] == "M"
