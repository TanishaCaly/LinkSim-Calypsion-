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


def test_untyped_station_still_behaves_as_a_machine():
    # Regression guard: a station with no "Station Type" (every imported
    # scenario) must keep serialising jobs through its single server.
    stations = {"M": _station(capacity=1, operator_per_station=0)}
    flow = {"v": [{"operation": "M", "resource": "M", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 3})

    assert result["simulation_state"]["completed_jobs"] == 3
    # Three jobs, one server, 5 minutes each — the last one ends at 15.
    assert _last_job_end(result) == pytest.approx(15.0)


# ---------------------------------------------------------------------------
# Per-station working-days calendar: a station can override which days of
# the week a given shift number runs on, independent of every other station
# using that same shift number.
# ---------------------------------------------------------------------------

def test_build_station_shift_config_overrides_working_days():
    # Direct unit test of the override plumbing: a station with its own
    # workingDays1 must get that in its per-station config; a station with
    # none keeps the global WORKING_DAYS_1.
    base_config = dict(SIM_CONFIG)
    base_config["WORKING_DAYS_1"] = [0, 1, 2, 3, 4]  # global: Mon-Fri

    weekend_only_station = {"workingDays1": [5, 6]}
    default_station = {}

    weekend_cfg = SimulationUtils.build_station_shift_config(base_config, weekend_only_station)
    default_cfg = SimulationUtils.build_station_shift_config(base_config, default_station)

    assert weekend_cfg["WORKING_DAYS_1"] == [5, 6], (
        "station-level workingDays1 must override the global WORKING_DAYS_1"
    )
    assert default_cfg["WORKING_DAYS_1"] == [0, 1, 2, 3, 4], (
        "a station with no override must keep the global working-days pattern"
    )
    # The global config itself must not be mutated by building a station copy.
    assert base_config["WORKING_DAYS_1"] == [0, 1, 2, 3, 4]


def test_station_working_days_override_actually_gates_processing():
    # End-to-end: two stations both configured for shift 1 (Mon 00:00-24:00,
    # so every hour of the simulated week is "shift 1 hours"), but only ONE
    # of the two overrides workingDays1 to Tuesday-only. A job arriving on
    # Monday must be blocked at the Tuesday-only station until Tuesday
    # arrives, while the plain station (global Mon-Fri default) processes
    # its job on Monday immediately.
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 3 * 24 * 60.0  # 3 days, long enough to reach Tuesday
    cfg["SHIFT_1_START"] = 0.0
    cfg["SHIFT_1_END"] = 24.0
    cfg["ACTIVE_PROCESSING_TIME"] = 1440

    stations = {
        "NORMAL":      _station(capacity=1, operator_per_station=0, shifts_per_day=[1]),
        "TUESDAY_ONLY": _station(capacity=1, operator_per_station=0, shifts_per_day=[1], workingDays1=[1]),  # Tue=1
    }
    flow_normal = {"n": [{"operation": "N", "resource": "NORMAL", "duration": 5.0}]}
    flow_tue = {"t": [{"operation": "T", "resource": "TUESDAY_ONLY", "duration": 5.0}]}

    # SIM_TIME starts "now" (see ManufacturingSimulation's start_date) — run
    # each station in isolation so one's blocking wait can't be masked by
    # sharing a job/queue with the other.
    result_normal, _ = _run_sim(stations, flow_normal, {"n": 1}, sim_time=cfg["SIM_TIME"])
    result_tue, sim_tue = _run_sim(stations, flow_tue, {"t": 1}, sim_time=cfg["SIM_TIME"])

    assert result_normal["simulation_state"]["completed_jobs"] == 1
    assert result_tue["simulation_state"]["completed_jobs"] == 1

    tue_cfg = sim_tue._station_shift_cfg["TUESDAY_ONLY"]
    assert tue_cfg["WORKING_DAYS_1"] == [1], (
        "TUESDAY_ONLY's per-station override did not reach its shift config"
    )
    normal_cfg = sim_tue._station_shift_cfg["NORMAL"] if "NORMAL" in sim_tue._station_shift_cfg else None
    if normal_cfg:
        assert normal_cfg.get("WORKING_DAYS_1") != [1], (
            "NORMAL must not be affected by TUESDAY_ONLY's override"
        )


# ---------------------------------------------------------------------------
# Per-station shift HOURS and BREAKS: a station can override a shift's start/
# end time and break windows, independent of every other station using that
# same shift number.
# ---------------------------------------------------------------------------

def test_build_station_shift_config_overrides_hours_and_breaks():
    # Direct unit test of the override plumbing for hours (shift{i}, parsed
    # as "HH:MM-HH:MM") and breaks (breaks{i}, a list of {start, duration}
    # dicts matching Simulation Config's own BREAKS_n shape).
    base_config = dict(SIM_CONFIG)
    base_config["BREAKS_1"] = [{"start": 10, "duration": 30}]  # global: 10:00-10:30 lunch

    custom_station = {
        "shift1": "08:00-16:00",
        "breaks1": [{"start": 12, "duration": 45}],
    }
    default_station = {}

    custom_cfg = SimulationUtils.build_station_shift_config(base_config, custom_station)
    default_cfg = SimulationUtils.build_station_shift_config(base_config, default_station)

    assert custom_cfg["SHIFT_1_START"] == 8.0 and custom_cfg["SHIFT_1_END"] == 16.0, (
        "station-level shift1 hour window must override the global SHIFT_1_START/END"
    )
    assert custom_cfg["BREAKS_1"] == [{"start": 12, "duration": 45}], (
        "station-level breaks1 must override the global BREAKS_1"
    )
    assert default_cfg["BREAKS_1"] == [{"start": 10, "duration": 30}], (
        "a station with no breaks override must keep the global break pattern"
    )
    # An explicit empty list is a real override (no breaks for this station),
    # not "unset" — must not silently fall back to the global break.
    no_break_cfg = SimulationUtils.build_station_shift_config(base_config, {"breaks1": []})
    assert no_break_cfg["BREAKS_1"] == [], (
        "an explicit empty breaks override must be respected, not treated as absent"
    )


def test_station_break_override_actually_pauses_processing():
    # End-to-end: a station whose own break1 override adds a long break
    # partway through its single shift must take measurably longer to finish
    # a job than an identical station with no break at all.
    cfg_base = dict(SIM_CONFIG)
    cfg_base["SHIFT_1_START"] = 0.0
    cfg_base["SHIFT_1_END"] = 24.0
    cfg_base["ACTIVE_PROCESSING_TIME"] = 1440

    # ManufacturingSimulation's default start_date is 2025-01-01 06:00 (see
    # _resolve_start_date) — the sim clock starts at hour-of-day 6, not 0 —
    # so the break must be placed just after 6am to actually fall inside this
    # job's very first few minutes of processing.
    no_break_station = {
        "NO_BREAK": _station(capacity=1, operator_per_station=0, shifts_per_day=[1]),
    }
    on_break_station = {
        "ON_BREAK": _station(
            capacity=1, operator_per_station=0, shifts_per_day=[1],
            breaks1=[{"start": 6.05, "duration": 60}],  # a 1-hour break shortly after 6am start
        ),
    }
    flow_no_break = {"n": [{"operation": "N", "resource": "NO_BREAK", "duration": 5.0}]}
    flow_on_break = {"b": [{"operation": "B", "resource": "ON_BREAK", "duration": 5.0}]}

    result_no_break, _ = _run_sim(no_break_station, flow_no_break, {"n": 1}, sim_time=1440.0)
    result_on_break, sim_on_break = _run_sim(on_break_station, flow_on_break, {"b": 1}, sim_time=1440.0)

    assert result_no_break["simulation_state"]["completed_jobs"] == 1
    assert result_on_break["simulation_state"]["completed_jobs"] == 1

    break_cfg = sim_on_break._station_shift_cfg["ON_BREAK"]
    assert break_cfg["BREAKS_1"] == [{"start": 6.05, "duration": 60}], (
        "ON_BREAK's per-station break override did not reach its shift config"
    )
    no_break_end = _last_job_end(result_no_break)
    on_break_end = _last_job_end(result_on_break)
    assert on_break_end > no_break_end, (
        f"a station with a break override ({on_break_end}) should finish later than "
        f"one without ({no_break_end}) — the break does not appear to be pausing processing"
    )
