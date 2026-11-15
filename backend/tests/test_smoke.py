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
# Conveyor (transport delay, no operator, Conveyor Capacity jobs at once)
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


def test_conveyor_speed_is_length_over_transport_time():
    # 30 m in 15 min = 2 m/min. The job rides for the given Transport Time
    # (not the step duration, 99), and the result reports all three.
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 15.0, "Conveyor Length": 30.0})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    result, _ = _run_sim(stations, flow, {"v": 1})

    assert _last_job_end(result) == pytest.approx(15.0)
    stat = result["station_stats"]["BELT"]
    assert (stat["conveyor_length"], stat["conveyor_speed"], stat["transport_time"]) == (30.0, 2.0, 15.0)


@pytest.mark.parametrize("position, passed", [
    ("Front", 2),   # sensor at 12 m: reached after 12 / 5 = 2.4 min of riding
    ("Rear", 1),    # sensor at 30 - 12 = 18 m: needs 3.6 min of riding
])
def test_conveyor_sensor_counts_jobs_that_passed(position, passed):
    # 30 m belt, 6 min ride = 5 m/min, one job at a time. Job 1 rides 0-6;
    # job 2 rides from 6 and has moved 3 min when the sim ends at 9. The
    # sensor only counts — the ride is unchanged (1 job completes either way).
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 30.0,
        "Conveyor Sensor Length": 12.0, "Conveyor Sensor Position": position})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    result, _ = _run_sim(stations, flow, {"v": 100}, sim_time=9.0)

    assert result["station_stats"]["BELT"]["sensor_passed"] == passed
    assert result["simulation_state"]["completed_jobs"] == 1


def test_conveyor_sensor_at_start_skips_job_let_on_as_run_ends():
    # Sensor at 0 m Front: job 1 gets on at 0, job 2 at 6, job 3 only when
    # the run ends at 9 (job 2's ride is cut there) — 2 passed, not 3.
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 30.0,
        "Conveyor Sensor Length": 0.0, "Conveyor Sensor Position": "Front"})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    result, _ = _run_sim(stations, flow, {"v": 100}, sim_time=9.0)

    assert result["station_stats"]["BELT"]["sensor_passed"] == 2


def test_job_freed_in_last_instant_stays_waiting():
    # 6 min belt, one at a time, run ends at 9: job 2 is still riding, so job
    # 3 never got on — it is "Waiting", not a second "In Progress" ride
    # starting in the run's last instant.
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 30.0})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    result, _ = _run_sim(stations, flow, {"v": 3}, sim_time=9.0)

    log = result["completion_log"]["BELT"]
    assert [e["status"] for e in log] == ["Completed", "In Progress", "Waiting"]
    assert log[2]["process_start_time_real"] is None


def test_run_ending_at_odd_time_finishes():
    # Station 1 (1 min) -> belt (6 min) -> Station 2 (1 min), run ends at
    # 16.5: float rounding near the end used to leave a chunk too small to
    # move the clock, and the job looped forever.
    stations = {
        "S1": _station(operator_per_station=0),
        "BELT": _station(operator_per_station=0, **{
            "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 30.0}),
        "S2": _station(operator_per_station=0),
    }
    flow = {"v": [{"operation": "S1", "resource": "S1", "duration": 1.0},
                  {"operation": "BELT", "resource": "BELT", "duration": 6.0},
                  {"operation": "S2", "resource": "S2", "duration": 1.0}]}
    result, _ = _run_sim(stations, flow, {"v": 8}, sim_time=16.5)

    assert result["simulation_state"]["completed_jobs"] == 2


def test_conveyor_sensor_count_resets_each_replication():
    # Same line as above; every replication passes 2 jobs, so the average is
    # 2 — not a running total across replications.
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 30.0,
        "Conveyor Sensor Length": 12.0, "Conveyor Sensor Position": "Front"})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 9.0
    sim = ManufacturingSimulation(stations, flow, {"v": 100}, {}, cfg)
    result = sim.run_with_replications(3)

    assert result["station_stats"]["BELT"]["sensor_passed"] == 2


def test_conveyor_sensor_longer_than_belt_stops_the_run():
    # Sensor set at 12 m, then the belt shortened to 10 m: an error, not a
    # sensor silently ignored.
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 10.0,
        "Conveyor Sensor Length": 12.0, "Conveyor Sensor Position": "Front"})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    with pytest.raises(ValueError, match=r"BELT: sensor \(12 m\) is longer than the conveyor \(10 m\)"):
        _run_sim(stations, flow, {"v": 1})


def test_conveyor_without_sensor_reports_none():
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 6.0, "Conveyor Length": 30.0})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 99.0}]}
    result, _ = _run_sim(stations, flow, {"v": 1})

    assert result["station_stats"]["BELT"]["sensor_passed"] is None
    assert _last_job_end(result) == pytest.approx(6.0)


def test_conveyor_transport_time_is_length_over_speed():
    # 30 m at 7 m/min = 30/7 min. Length + Speed win over a stale Transport
    # Time (99) and the step duration (50).
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Conveyor Length": 30.0, "Conveyor Speed": 7.0,
        "Transport Time": 99.0})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 50.0}]}
    result, _ = _run_sim(stations, flow, {"v": 1})

    assert _last_job_end(result) == pytest.approx(30.0 / 7.0)
    stat = result["station_stats"]["BELT"]
    assert stat["conveyor_speed"] == pytest.approx(7.0)
    assert stat["transport_time"] == pytest.approx(30.0 / 7.0)


def test_conveyor_carries_jobs_concurrently():
    # Ten jobs on a belt with Conveyor Capacity 10. A machine would serialise
    # them (last one done at t=50); a belt carries them all at once, so every
    # job is off the belt after a single transport time.
    stations = {
        "BELT": _station(
            capacity=1, operator_per_station=0,
            **{"Station Type": "Conveyor", "Transport Time": 5.0, "Conveyor Capacity": 10},
        ),
    }
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 10})

    assert result["simulation_state"]["completed_jobs"] == 10
    assert _last_job_end(result) == pytest.approx(5.0), (
        "jobs queued one-at-a-time instead of riding the belt together"
    )


def test_conveyor_capacity_defaults_to_one():
    # No Conveyor Capacity saved -> 1 job on the belt at a time.
    stations = {"BELT": _station(operator_per_station=0, **{"Station Type": "Conveyor", "Transport Time": 5.0})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 3})

    assert result["simulation_state"]["completed_jobs"] == 3
    assert _last_job_end(result) == pytest.approx(15.0)


def test_conveyor_capacity_zero_takes_no_job():
    stations = {"BELT": _station(operator_per_station=0, **{
        "Station Type": "Conveyor", "Transport Time": 5.0, "Conveyor Capacity": 0})}
    flow = {"v": [{"operation": "BELT", "resource": "BELT", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 3})

    assert result["simulation_state"]["completed_jobs"] == 0


def test_conveyor_first_on_first_off():
    # No Transport Time, so each job rides for its own step duration: the fast
    # job finishes at 5 but must wait behind the slow one until 20.
    stations = {"BELT": _station(operator_per_station=0, **{"Station Type": "Conveyor", "Conveyor Capacity": 2})}
    flow = {
        "slow": [{"operation": "BELT", "resource": "BELT", "duration": 20.0}],
        "fast": [{"operation": "BELT", "resource": "BELT", "duration": 5.0}],
    }
    result, _ = _run_sim(stations, flow, {"slow": 1, "fast": 1})

    ends = [e["process_end_time_real"] for e in result["completion_log"]["BELT"]]
    assert ends == ["2025-01-01 06:20:00", "2025-01-01 06:20:00"]


def test_conveyor_stops_while_front_job_is_stuck():
    # A(2) -> BELT(capacity 3, 10 min) -> M(30). Job 2 reaches the end at 14
    # but M is busy until 42, so the whole belt stops: job 3 (on since 6) has
    # 2 min left and job 4 (on since 12) 8 min left. They finish those after
    # the belt restarts — job 3 at 44, job 4 (stopped again 44-72) at 78.
    stations = {
        "A": _station(operator_per_station=0),
        "BELT": _station(operator_per_station=0, **{
            "Station Type": "Conveyor", "Transport Time": 10.0, "Conveyor Capacity": 3}),
        "M": _station(operator_per_station=0),
    }
    flow = {"v": [
        {"operation": "A", "resource": "A", "duration": 2.0},
        {"operation": "BELT", "resource": "BELT", "duration": 10.0},
        {"operation": "M", "resource": "M", "duration": 30.0},
    ]}
    result, _ = _run_sim(stations, flow, {"v": 4})

    belt = {e["job_id"]: e for e in result["completion_log"]["BELT"]}
    assert belt["v-004"]["process_start_time_real"] == "2025-01-01 06:12:00", "belt was full until job 1 left"
    assert belt["v-003"]["process_end_time_real"] == "2025-01-01 06:44:00"
    assert belt["v-004"]["process_end_time_real"] == "2025-01-01 07:18:00"
    assert all(e["Processing Time"] == pytest.approx(10.0) for e in belt.values())


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


def _exit_controller_machines(strategy, priorities=None):
    # Station 1 (2 min) feeds Station 2 with 3 parallel machines (3 min each),
    # failures OFF on both — they must still be 3 separate machines, so the
    # Exit Controller decides which one each job goes to.
    s1 = {"Exit Strategy": strategy, "Enable Failures": False}
    if priorities:
        s1["Exit Priorities"] = priorities
    stations = {
        "Station 1": _station(operator_per_station=0, **s1),
        "Station 2": _station(operator_per_station=0, capacity=3, **{"Enable Failures": False}),
    }
    flow = {"v": [{"operation": "S1", "resource": "Station 1", "duration": 2.0},
                  {"operation": "S2", "resource": "Station 2", "duration": 3.0}]}
    result, _ = _run_sim(stations, flow, {"v": 6})
    assert result["simulation_state"]["completed_jobs"] == 6
    assert _last_job_end(result) == pytest.approx(15.0)
    return [e["machine"] for e in result["completion_log"]["Station 2"]]


def test_exit_controller_cyclic_with_failures_off():
    # Job 3 goes to #3 even though #1 is free by then — it's #3's turn.
    assert _exit_controller_machines("cyclic") == [1, 2, 3, 1, 2, 3]


def test_exit_controller_successor_with_failures_off():
    # #2 is best, then #1: #2 whenever free, else #1; #3 is never needed.
    prios = {"Station 2 #1": 2, "Station 2 #2": 1, "Station 2 #3": 3}
    assert _exit_controller_machines("successor", prios) == [2, 1, 2, 1, 2, 1]


def test_exit_controller_random_with_failures_off():
    # Random picks among free machines, so every job still gets a real one.
    machines = _exit_controller_machines("random")
    assert len(machines) == 6 and set(machines) <= {1, 2, 3}


def _split_line(strategy, times, priorities=None, capacities=None, qty=6, branch_first=False):
    # Station 1 (2 min) -> one of Station 2 / 3 / ... (a split: each job goes
    # to only ONE of them, picked by Station 1's Exit Controller). Returns
    # (where each job went in job order, sim). times: {station: minutes}.
    s1 = {"Exit Strategy": strategy, "Enable Failures": False}
    if priorities:
        s1["Exit Priorities"] = priorities
    stations = {"Station 1": _station(operator_per_station=0, **s1)}
    flow = [] if branch_first else [{"operation": "S1", "resource": "Station 1", "duration": 2.0}]
    for name, minutes in times.items():
        cap = (capacities or {}).get(name, 1)
        stations[name] = _station(operator_per_station=0, capacity=cap, **{"Enable Failures": False})
        flow.append({"operation": name, "resource": name, "duration": minutes, "branch": 1})
    result, sim = _run_sim(stations, {"v": flow}, {"v": qty})
    assert result["simulation_state"]["completed_jobs"] == qty
    went = {}
    for name in times:
        for e in result["completion_log"].get(name, []):
            label = f"{name} #{e['machine']}" if "machine" in e else name
            went[int(e["job_id"][-3:])] = label
    assert sorted(went) == list(range(1, qty + 1)), "every job visits exactly one branch"
    return [went[j] for j in sorted(went)], sim


SPLIT_TIMES = {"Station 2": 5.0, "Station 3": 13.0, "Station 4": 10.0}


def test_split_cyclic_skips_busy_and_blocks_station_1():
    # Jobs leave Station 1 at 2, 4, 6, 8, ... Turns 2 -> 3 -> 4; job 4 finds
    # only Station 2 free (its turn), job 5 waits on Station 1 (10 -> 13)
    # until Station 2 frees, job 6 waits (15 -> 16) for Station 4.
    went, sim = _split_line("cyclic", SPLIT_TIMES)
    assert went == ["Station 2", "Station 3", "Station 4", "Station 2", "Station 2", "Station 4"]
    assert sim.stations_data["Station 1"]["total_block_time"] == pytest.approx(4.0)


def test_split_successor_uses_priorities():
    # Station 3 first, then 2, then 4 — always the best free one.
    prios = {"Station 2": 2, "Station 3": 1, "Station 4": 3}
    went, _ = _split_line("successor", SPLIT_TIMES, prios)
    assert went == ["Station 3", "Station 2", "Station 4", "Station 2", "Station 2", "Station 3"]


def test_split_random_sends_each_job_to_one_station():
    went, _ = _split_line("random", SPLIT_TIMES)
    assert set(went) <= set(SPLIT_TIMES)


def test_split_parallel_copies_are_separate_choices():
    # Station 2 has 2 machines: choices are #1, #2, Station 3 in turn.
    went, _ = _split_line("cyclic", {"Station 2": 10.0, "Station 3": 11.0},
                          capacities={"Station 2": 2}, qty=4)
    assert went == ["Station 2 #1", "Station 2 #2", "Station 3", "Station 2 #1"]


def test_split_as_first_step():
    # The line starts with the split: both jobs arrive at 0 and spread out.
    went, _ = _split_line("cyclic", {"Station 2": 5.0, "Station 3": 5.0}, qty=2, branch_first=True)
    assert went == ["Station 2", "Station 3"]


def _buffer_line(buffer_cfg, station2_cfg=None, qty=6):
    # Station 1 (1 min) -> [Buffer 1] -> Station 2 (5 min): jobs pile up
    # between them. buffer_cfg None = no Buffer box (Station 2's own buffer).
    stations = {"Station 1": _station(operator_per_station=0, **{"Enable Failures": False})}
    flow = [{"operation": "a", "resource": "Station 1", "duration": 1.0}]
    if buffer_cfg is not None:
        stations["Buffer 1"] = _station(operator_per_station=0, **{"Station Type": "Buffer", **buffer_cfg})
        flow.append({"operation": "b", "resource": "Buffer 1", "duration": 0.0})
    stations["Station 2"] = _station(operator_per_station=0, **{"Enable Failures": False, **(station2_cfg or {})})
    flow.append({"operation": "c", "resource": "Station 2", "duration": 5.0})
    result, _ = _run_sim(stations, {"v": flow}, {"v": qty})
    assert result["simulation_state"]["completed_jobs"] == qty
    minute = lambda e: int(str(e["process_start_time_real"])[14:16])
    s1_starts = [minute(e) for e in result["completion_log"]["Station 1"]]
    s2_order = [int(e["job_id"][-3:]) for e in sorted(result["completion_log"]["Station 2"], key=minute)]
    return s1_starts, s2_order, result


def test_buffer_2d_holds_its_quantity_and_blocks_station_1():
    # Buffer of 2: jobs 2 and 3 wait in it, job 4 stays on Station 1, so
    # Station 1 can only start job 5 when job 2 leaves at 06:06 — not later.
    s1, s2, result = _buffer_line({"Buffer Capacity": 2})
    assert s1 == [0, 1, 2, 3, 6, 11]
    assert s2 == [1, 2, 3, 4, 5, 6]
    assert result["station_stats"]["Station 1"]["buffer_blocked_time"] == pytest.approx(10.0)


def test_buffer_2d_lifo_sends_newest_job_first():
    _, s2, _ = _buffer_line({"Buffer Capacity": 2, "Buffer Discipline": "LIFO"})
    assert s2 == [1, 3, 4, 5, 6, 2]
    _, s2, _ = _buffer_line({"Buffer Unlimited": True, "Buffer Discipline": "LIFO"})
    assert s2 == [1, 6, 5, 4, 3, 2]


def test_buffer_capacity_zero_passes_jobs_straight_through():
    # No room in the box: as if it weren't there — Station 1 holds each job
    # until Station 2 is free, and every job still completes.
    s1, s2, result = _buffer_line({"Buffer Capacity": 0})
    assert s1 == [0, 1, 6, 11, 16, 21]
    assert s2 == [1, 2, 3, 4, 5, 6]
    assert result["station_stats"]["Station 1"]["buffer_blocked_time"] == pytest.approx(20.0)


def test_buffer_3d_rack_size_limits_the_line():
    # A 2x1x1 rack holds 2 jobs, exactly like a 2D buffer of 2.
    s1, _, _ = _buffer_line({"Buffer Config Mode": "3D", "Buffer X": 2, "Buffer Y": 1, "Buffer Z": 1})
    assert s1 == [0, 1, 2, 3, 6, 11]


def test_buffer_3d_lifo_only_takes_lane_fronts():
    # 2 lanes, 2 deep: lane A = 2,4  lane B = 3,5 (then 6 behind 5). LIFO picks
    # the newest FRONT job each time — job 4 is stuck behind 2 until 2 leaves.
    _, s2, _ = _buffer_line({"Buffer Config Mode": "3D", "Buffer X": 2, "Buffer Y": 2, "Buffer Z": 1,
                             "Buffer Discipline": "LIFO"})
    assert s2 == [1, 3, 5, 6, 2, 4]


def test_station_own_buffer_quantity_blocks_and_orders():
    s1, s2, _ = _buffer_line(None, {"Buffer Capacity": 2})
    assert s1 == [0, 1, 2, 3, 6, 11]
    assert s2 == [1, 2, 3, 4, 5, 6]
    _, s2, _ = _buffer_line(None, {"Buffer Unlimited": True, "Buffer Discipline": "LIFO"})
    assert s2 == [1, 6, 5, 4, 3, 2]


def _parallel_group_line(times, buffers, strategy="cyclic", priorities=None, qty=6):
    # Station 1 (2 min) -> a parallel group "Station 2": each machine is a
    # station of its own (own name, own time), sharing one waiting line whose
    # room is the machines' buffers added together. Returns (machine each job
    # went to, in job order, sim).
    s1 = {"Exit Strategy": strategy, "Enable Failures": False}
    if priorities:
        s1["Exit Priorities"] = priorities
    stations = {"Station 1": _station(operator_per_station=0, **s1)}
    flow = [{"operation": "S1", "resource": "Station 1", "duration": 2.0}]
    for name, minutes in times.items():
        buf = buffers.get(name, 0)
        extra = {"Buffer Unlimited": True} if buf is None else {"Buffer Capacity": buf}
        stations[name] = _station(operator_per_station=0, **{
            "Enable Failures": False, "Parallel Group": "Station 2", **extra})
        flow.append({"operation": name, "resource": name, "duration": minutes, "branch": 1})
    result, sim = _run_sim(stations, {"v": flow}, {"v": qty})
    assert result["simulation_state"]["completed_jobs"] == qty
    went = {}
    for name in times:
        for e in result["completion_log"].get(name, []):
            went[int(e["job_id"][-3:])] = name
    assert sorted(went) == list(range(1, qty + 1)), "every job visits exactly one machine"
    return [went[j] for j in sorted(went)], sim, result


def test_parallel_group_shared_line():
    # A and B take 10 min, room in the line = 1 + 1. Jobs 3 and 4 wait in the
    # line (Station 1 is free to carry on); job 5 finds it full and blocks
    # Station 1 from 10 to 12, when job 3 leaves the line for A.
    went, sim, result = _parallel_group_line({"Stitching A": 10.0, "Stitching B": 10.0},
                                             {"Stitching A": 1, "Stitching B": 1})
    assert went == ["Stitching A", "Stitching B"] * 3
    assert sim.stations_data["Station 1"]["total_block_time"] == pytest.approx(2.0)
    assert _last_job_end(result) == pytest.approx(34.0)
    # Job 3 joined the line at 6 and finished on A at 22.
    job3 = next(e for e in result["completion_log"]["Stitching A"] if e["job_id"].endswith("003"))
    assert job3["Cycle Time"] == pytest.approx(16.0)


def test_parallel_group_no_buffer_waits_on_station_1():
    # Room 0: like a split, the job waits on Station 1 until a machine frees.
    went, sim, _ = _parallel_group_line({"Stitching A": 10.0, "Stitching B": 10.0}, {})
    assert went == ["Stitching A", "Stitching B"] * 3
    assert sim.stations_data["Station 1"]["total_block_time"] > 2.0


def test_parallel_group_own_times_and_unlimited_line():
    # B is faster (4 min); an unlimited line never blocks Station 1.
    went, sim, _ = _parallel_group_line({"Stitching A": 10.0, "Stitching B": 4.0},
                                        {"Stitching A": None})
    assert went.count("Stitching B") > went.count("Stitching A")
    assert sim.stations_data["Station 1"].get("total_block_time", 0) == pytest.approx(0.0)


def test_parallel_group_successor_by_machine_name():
    # Priorities are keyed by each machine's own name: B first, A only when B is busy.
    went, _, _ = _parallel_group_line({"Stitching A": 1.5, "Stitching B": 1.5}, {},
                                      strategy="successor",
                                      priorities={"Stitching A": 2, "Stitching B": 1})
    assert went == ["Stitching B"] * 6


def _start_line(strategy, priorities=None, quantities=None):
    # Start (with its MU table + Exit Controller) -> M (1 min). Products are
    # released batch by batch; each job comes its product's interval after
    # the job before it.
    start = {"Station Type": "Source", "MU Strategy": strategy, "MU Table": [
        {"mu": "tshirt", "number": 2, "name": "Tshirt"},
        {"mu": "pant", "number": 2, "name": "Pant"},
        {"mu": "shirt", "number": 1, "name": "Shirt"},
    ]}
    if priorities:
        start["MU Priorities"] = priorities
    stations = {"Start": start, "M": _station(operator_per_station=0, **{"Buffer Unlimited": True})}
    flow = {v: [{"operation": "M", "resource": "M", "duration": 1.0}] for v in ("tshirt", "pant", "shirt")}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, quantities or {"tshirt": 2, "pant": 2, "shirt": 1}, {}, cfg,
                                  variant_intervals={"tshirt": 5, "pant": 8})
    return sim


def test_start_cyclic_releases_batch_by_batch():
    sim = _start_line("cyclic")
    assert sim._release_schedule() == [
        ("tshirt", 1, 0.0), ("tshirt", 2, 5.0), ("pant", 1, 13.0), ("pant", 2, 21.0), ("shirt", 1, 21.0)]
    result = sim.run()
    assert result["simulation_state"]["completed_jobs"] == 5
    order = [e["job_id"] for e in result["completion_log"]["M"]]
    assert order == ["tshirt-001", "tshirt-002", "pant-001", "pant-002", "shirt-001"]


def test_start_successor_uses_priorities():
    sim = _start_line("successor", {"tshirt": 3, "pant": 2, "shirt": 1})
    assert [v for v, i, _ in sim._release_schedule() if i == 1] == ["shirt", "pant", "tshirt"]


def test_start_random_keeps_batches_together():
    order = [v for v, _, _ in _start_line("random")._release_schedule()]
    batches = [v for k, v in enumerate(order) if k == 0 or order[k - 1] != v]
    assert sorted(batches) == ["pant", "shirt", "tshirt"]


def test_start_percentage_or_unset_keeps_old_arrivals():
    assert _start_line("percentage")._release_schedule() is None
    assert _start_line("")._release_schedule() is None


def _two_starts(strategy_2="cyclic"):
    # Start releases A (its MU table), Start 2 releases B; each part goes
    # through its own station. Both Starts start at minute 0, together.
    stations = {
        "Start": {"Station Type": "Source", "MU Strategy": "cyclic", "MU Table": [{"mu": "a", "number": 3}]},
        "Start 2": {"Station Type": "Source", "MU Strategy": strategy_2, "MU Table": [{"mu": "b", "number": 2}]},
        "MA": _station(operator_per_station=0, **{"Buffer Unlimited": True}),
        "MB": _station(operator_per_station=0, **{"Buffer Unlimited": True}),
    }
    flow = {"a": [{"operation": "MA", "resource": "MA", "duration": 2.0}],
            "b": [{"operation": "MB", "resource": "MB", "duration": 3.0}]}
    cfg = dict(SIM_CONFIG)
    cfg["SIM_TIME"] = 480.0
    return ManufacturingSimulation(stations, flow, {"a": 3, "b": 2}, {}, cfg, variant_intervals={"a": 4, "b": 10})


def test_each_start_releases_its_own_parts_at_the_same_time():
    sim = _two_starts()
    # A every 4 min from 0, B every 10 min from 0 — not B after all of A.
    assert sim._release_schedule() == [("a", 1, 0.0), ("a", 2, 4.0), ("a", 3, 8.0), ("b", 1, 0.0), ("b", 2, 10.0)]
    result = sim.run()
    assert result["simulation_state"]["completed_jobs"] == 5
    first_b = result["completion_log"]["MB"][0]
    assert first_b["job_id"] == "b-001" and first_b["process_start_time_real"].endswith("06:00:00")


def test_part_in_no_start_table_goes_to_first_start():
    sim = _two_starts()
    sim.stations_data["Start 2"]["MU Table"] = []
    # B listed nowhere: released by the first Start, after its A batch (each
    # job its own product's interval after the job before it).
    assert sim._release_schedule() == [("a", 1, 0.0), ("a", 2, 4.0), ("a", 3, 8.0), ("b", 1, 18.0), ("b", 2, 28.0)]


def test_start_on_percentage_lets_its_parts_arrive_on_their_own():
    # Start 2 on Percentage (UI only): its parts arrive on their own interval.
    assert [x for x in _two_starts("percentage")._release_schedule() if x[0] == "b"] == [("b", 1, 0.0), ("b", 2, 10.0)]


def _routed(routes, stations, flow, quantities):
    # Station 1 gets Route by product (product -> ticked next boxes).
    stations["Station 1"].update({"Route By Product": True, "Product Routes": routes})
    return _run_sim(stations, flow, quantities)


def test_route_by_product_split():
    # tshirt may only go to Station 2, pant only to Station 3 — each waits
    # (on Station 1) for its own station even when the other one is free.
    stations = {n: _station(operator_per_station=0, **{"Enable Failures": False})
                for n in ("Station 1", "Station 2", "Station 3")}
    steps = [{"operation": "S1", "resource": "Station 1", "duration": 2.0},
             {"operation": "S2", "resource": "Station 2", "duration": 10.0, "branch": 1},
             {"operation": "S3", "resource": "Station 3", "duration": 10.0, "branch": 1}]
    result, _ = _routed({"tshirt": ["Station 2"], "pant": ["Station 3"]}, stations,
                        {"tshirt": steps, "pant": steps}, {"tshirt": 2, "pant": 2})
    assert result["simulation_state"]["completed_jobs"] == 4
    assert {e["job_id"][:-4] for e in result["completion_log"]["Station 2"]} == {"tshirt"}
    assert {e["job_id"][:-4] for e in result["completion_log"]["Station 3"]} == {"pant"}
    assert _last_job_end(result) == pytest.approx(34.0)


def test_route_by_product_machines_of_one_station():
    # Station 2 has 2 machines (an older station): tshirt only on #1, pant on either.
    stations = {"Station 1": _station(operator_per_station=0, **{"Enable Failures": False}),
                "Station 2": _station(operator_per_station=0, capacity=2, **{"Enable Failures": False})}
    steps = [{"operation": "S1", "resource": "Station 1", "duration": 2.0},
             {"operation": "S2", "resource": "Station 2", "duration": 10.0}]
    result, _ = _routed({"tshirt": ["Station 2 #1"], "pant": ["Station 2 #1", "Station 2 #2"]}, stations,
                        {"tshirt": steps, "pant": steps}, {"tshirt": 2, "pant": 1})
    assert result["simulation_state"]["completed_jobs"] == 3
    log = result["completion_log"]["Station 2"]
    assert [e["machine"] for e in log if e["job_id"].startswith("tshirt")] == [1, 1]


def test_route_by_product_shared_line_keeps_order():
    # A and B share one waiting line (room 2). tshirt only A, pant only B.
    # The 2nd tshirt waits in the line for A; the pant behind it waits too,
    # even though B is free, and only gets B when the tshirt leaves (at 11).
    stations = {"Station 1": _station(operator_per_station=0, **{"Enable Failures": False})}
    steps = [{"operation": "S1", "resource": "Station 1", "duration": 1.0}]
    for m in ("A", "B"):
        stations[m] = _station(operator_per_station=0, **{"Enable Failures": False, "Parallel Group": "G", "Buffer Capacity": 1})
        steps.append({"operation": m, "resource": m, "duration": 10.0, "branch": 1})
    result, _ = _routed({"tshirt": ["A"], "pant": ["B"]}, stations,
                        {"tshirt": steps, "pant": steps}, {"tshirt": 2, "pant": 1})
    assert result["simulation_state"]["completed_jobs"] == 3
    pant = result["completion_log"]["B"][0]
    assert pant["job_id"] == "pant-001"
    assert pant["Cycle Time"] == pytest.approx(18.0)  # joined the line at 3, done at 21


def test_route_by_product_missing_tick_stops_the_run():
    stations = {n: _station(operator_per_station=0) for n in ("Station 1", "Station 2", "Station 3")}
    steps = [{"operation": "S1", "resource": "Station 1", "duration": 2.0},
             {"operation": "S2", "resource": "Station 2", "duration": 10.0, "branch": 1},
             {"operation": "S3", "resource": "Station 3", "duration": 10.0, "branch": 1}]
    with pytest.raises(ValueError, match="pant"):
        _routed({"tshirt": ["Station 2"]}, stations, {"tshirt": steps, "pant": steps}, {"tshirt": 1, "pant": 1})


@pytest.mark.parametrize("saved_strategy", ["cyclic", "random"])
def test_route_by_product_cyclic_is_strict_per_product(saved_strategy):
    # Cyclic + Route by product: each product cycles over ITS ticked
    # machines from the first one (A, B, A, ...) and waits for the one whose
    # turn it is — never skips to a free one. tshirt only A; pant A or B.
    # pant-001's turn is A, busy with tshirts until 21, so it waits (B idle);
    # then pant-002 -> B, pant-003 -> A.
    # Route based is always Cyclic — also one saved with Random before.
    stations = {"Station 1": _station(operator_per_station=0, **{"Enable Failures": False, "Exit Strategy": saved_strategy})}
    steps = [{"operation": "S1", "resource": "Station 1", "duration": 1.0}]
    for m in ("A", "B"):
        stations[m] = _station(operator_per_station=0, **{"Enable Failures": False, "Parallel Group": "G", "Buffer Capacity": 1})
        steps.append({"operation": m, "resource": m, "duration": 10.0, "branch": 1})
    result, _ = _routed({"tshirt": ["A"], "pant": ["A", "B"]}, stations,
                        {"tshirt": steps, "pant": steps}, {"tshirt": 2, "pant": 3})
    assert result["simulation_state"]["completed_jobs"] == 5
    went = {}
    for m in ("A", "B"):
        for e in result["completion_log"][m]:
            went[e["job_id"]] = m
    assert [went[f"pant-00{k}"] for k in (1, 2, 3)] == ["A", "B", "A"]
    assert [went[f"tshirt-00{k}"] for k in (1, 2)] == ["A", "A"]
    assert _last_job_end(result) == pytest.approx(41.0)


# ── Assembly ─────────────────────────────────────────────────────────────────
# Car example: bodies (a) from Start through S1 (10 min), wheels (b) from
# Start 2 through S5; both into ASM (5 min), then S4 (1 min). Lines into ASM,
# in the order connected: S1 = 1, S5 = 2.

def _assembly_line(assembly, a=2, b=2, wheel_time=2.0):
    stations = {
        "Start": {"Station Type": "Source", "MU Strategy": "cyclic", "MU Table": [{"mu": "a", "number": a}]},
        "Start 2": {"Station Type": "Source", "MU Strategy": "cyclic", "MU Table": [{"mu": "b", "number": b}]},
        "S1": _station(operator_per_station=0),
        "S5": _station(operator_per_station=0),
        "ASM": _station(operator_per_station=0, **{"Station Type": "Assembly", "Assembly": assembly}),
        "S4": _station(operator_per_station=0),
    }
    flow = {
        "a": [{"operation": "S1", "resource": "S1", "duration": 10.0},
              {"operation": "ASM", "resource": "ASM", "duration": 5.0},
              {"operation": "S4", "resource": "S4", "duration": 1.0}],
        "b": [{"operation": "S5", "resource": "S5", "duration": wheel_time},
              {"operation": "ASM", "resource": "ASM", "duration": 0.0}],
    }
    return stations, flow, {"a": a, "b": b}


def _asm(**over):
    cfg = {"table": "none", "mainMuFromPredecessor": 1, "mainMuDefault": True,
           "mode": "delete_mus", "exitingMu": "main_mu",
           "lines": [{"from": "S1", "no": 1, "amount": 1}, {"from": "S5", "no": 2, "amount": 1}]}
    cfg.update(over)
    return cfg


def _ends(result, station):
    return [(e["job_id"], e["process_end_time_real"][11:16]) for e in result["completion_log"][station]
            if e.get("status") == "Completed"]


def test_assembly_none_delete_main():
    # b1 is in the room at 2 (b2 then blocks S5); a1 reaches ASM at 10, takes
    # b1 (deleted), works 10-15, S4 15-16. a2: S1 10-20, ASM 20-25 with b2.
    result, _ = _run_sim(*_assembly_line(_asm()))
    assert _ends(result, "S4") == [("a-001", "06:16"), ("a-002", "06:26")]
    assert result["simulation_state"]["completed_jobs"] == 2
    assert result["simulation_state"]["assembled_parts"] == 2
    parts = {e["job_id"]: e for e in result["completion_log"]["ASM"] if e["job_id"].startswith("b")}
    assert parts["b-001"]["status"] == "Assembled"
    assert parts["b-001"]["delay_reason"] == "Used in a-001 (Delete entity)"


def test_assembly_none_main_is_the_line_named():
    # Main MU 2: line 2 (S5, the wheels) is the main part, with its own ASM
    # time (0 min). b1 sits on ASM from 2 until a1 comes at 10 (a1 deleted);
    # b2 gets on at 10 and waits for a2 (S1 10-20).
    result, _ = _run_sim(*_assembly_line(_asm(mainMuFromPredecessor=2, mainMuDefault=False)))
    assert _ends(result, "ASM") == [("b-001", "06:10"), ("b-002", "06:20")]
    assert result["simulation_state"]["completed_jobs"] == 2
    parts = {e["job_id"]: e for e in result["completion_log"]["ASM"] if e["job_id"].startswith("a")}
    assert parts["a-001"]["delay_reason"] == "Used in b-001 (Delete entity)"


def test_assembly_main_part_waits_on_the_machine_for_its_parts():
    # Slow wheels (12 min): a1 sits on ASM from 10 until b1 comes at 12
    # (12-17, S4 17-18); a2 can't get on before 17, finishes S1 at 20, waits
    # on ASM for b2 until 24 (24-29, S4 29-30). 2 + 4 min waiting for parts.
    result, sim = _run_sim(*_assembly_line(_asm(), wheel_time=12.0))
    assert _ends(result, "S4") == [("a-001", "06:18"), ("a-002", "06:30")]
    assert result["station_stats"]["ASM"]["parts_wait_time"] == pytest.approx(6.0)


def test_assembly_predecessors_attach_new_fe():
    # 1 body + 2 wheels -> a Car. b1, b2 in the room by 4 (b3 blocks S5);
    # a1 at 10 takes them: Car-001 10-15, S4 15-16; b3 in at 15 (when
    # Car-001 has left ASM), b4 at 17; a2 at 20 takes them: Car-002 20-25.
    cfg = _asm(table="predecessors", mainMuFromPredecessor=1, mainMuDefault=True, mode="attach_mus",
               exitingMu="new_fe", newFeName="Car",
               lines=[{"from": "S1", "no": 1, "amount": 1}, {"from": "S5", "no": 2, "amount": 2}])
    result, _ = _run_sim(*_assembly_line(cfg, b=4))
    assert _ends(result, "S4") == [("Car-001", "06:16"), ("Car-002", "06:26")]
    assert result["simulation_state"]["completed_jobs"] == 2
    assert result["simulation_state"]["assemblies"]["Car-001"]["parts"] == ["b-001", "b-002"]
    parts = {e["job_id"]: e for e in result["completion_log"]["ASM"] if e["job_id"].startswith("b")}
    assert parts["b-003"]["delay_reason"] == "Attached to Car-002"
    # The next car's wheels wait on S5 until Car-001 has left the Assembly.
    assert parts["b-003"]["process_start_time_real"][11:16] == "06:15"
    assert parts["b-004"]["process_start_time_real"][11:16] == "06:17"


def test_assembly_flow_entity_takes_parts_by_product():
    cfg = _asm(table="mu_types", mainMuFromPredecessor=1, mainMuDefault=True, muTypeRows=[{"mu": "b", "amount": 1}])
    result, _ = _run_sim(*_assembly_line(cfg))
    assert _ends(result, "S4") == [("a-001", "06:16"), ("a-002", "06:26")]


def test_assembly_flow_entity_part_not_in_table_stops_the_run():
    cfg = _asm(table="mu_types", mainMuFromPredecessor=1, mainMuDefault=True, muTypeRows=[{"mu": "c", "amount": 1}])
    with pytest.raises(ValueError, match="ASM: b comes in from S5, but it isn't in the FE table"):
        _run_sim(*_assembly_line(cfg))


@pytest.mark.parametrize("over, message", [
    ({"exitingMu": "new_fe", "newFeName": "Car"}, "Delete entity keeps only the main part"),
    ({"mode": "attach_mus"}, "with 2 lines, Attach all parts needs a New FE"),
    ({"mainMuFromPredecessor": 3, "mainMuDefault": False}, "Main FE from predecessor is 3, but only 2 lines come in"),
    ({"mode": "attach_mus", "exitingMu": "new_fe", "newFeName": " "}, "give the New FE a name"),
])
def test_assembly_settings_that_cannot_work_stop_the_run(over, message):
    with pytest.raises(ValueError, match=message):
        _run_sim(*_assembly_line(_asm(**over)))


def test_assembly_flow_entity_main_line_too_big_stops_the_run():
    cfg = _asm(table="mu_types", mainMuFromPredecessor=3, mainMuDefault=False, muTypeRows=[{"mu": "b", "amount": 1}])
    with pytest.raises(ValueError, match="Main FE from predecessor is 3, but only 2 lines come in"):
        _run_sim(*_assembly_line(cfg))


def test_assembly_uneven_quantities_warn_and_extra_body_waits():
    # 3 bodies, 2 wheels: 2 cars; the 3rd body sits on ASM waiting forever.
    result, _ = _run_sim(*_assembly_line(_asm(), a=3, b=2))
    assert result["simulation_state"]["warnings"] == [
        "ASM: parts for only 2 assemblies — 1 main parts can never be used."]
    assert result["simulation_state"]["completed_jobs"] == 2
    a3 = [e for e in result["completion_log"]["ASM"] if e["job_id"] == "a-003"][0]
    assert a3["status"] == "Waiting" and a3["delay_reason"] == "Waiting for parts"


def test_station_named_assembly_without_settings_runs_as_before():
    stations, flow, qty = _assembly_line(_asm())
    del stations["ASM"]["Assembly"]
    result, _ = _run_sim(stations, flow, qty)
    # No joining: all 4 jobs finish (bodies via S4, wheels at ASM).
    assert result["simulation_state"]["completed_jobs"] == 4
    assert result["simulation_state"]["assembled_parts"] == 0


def _two_bodies(**over):
    # Predecessors: 2 bodies (line 1, the main line) + 3 wheels (line 2).
    return _asm(table="predecessors", mainMuFromPredecessor=1, mainMuDefault=True,
                lines=[{"from": "S1", "no": 1, "amount": 2}, {"from": "S5", "no": 2, "amount": 3}], **over)


def test_assembly_main_line_amount_more_than_one_delete():
    # a1 sits on ASM from 10; a2 (S1 10-20) goes to the room as a part; the 3
    # wheels are in by 6 -> 20-25, S4 25-26. b4-b6 refill the room by 24;
    # a3 sits from 30, a4 joins at 40 -> 40-45, S4 45-46.
    result, _ = _run_sim(*_assembly_line(_two_bodies(), a=4, b=6))
    # Main FE from 2 bodies each: renumbered 1, 2 (a-A001, a-A002).
    assert _ends(result, "S4") == [("a-A001", "06:26"), ("a-A002", "06:46")]
    assert result["simulation_state"]["completed_jobs"] == 2
    assert result["simulation_state"]["assembled_parts"] == 8
    a2 = [e for e in result["completion_log"]["ASM"] if e["job_id"] == "a-002"][0]
    assert a2["delay_reason"] == "Used in a-A001 (Delete entity)"
    assert result["simulation_state"]["assemblies"]["a-A002"]["main"] == "a-003"


def test_assembly_main_line_amount_more_than_one_attach_new_fe():
    result, _ = _run_sim(*_assembly_line(
        _two_bodies(mode="attach_mus", exitingMu="new_fe", newFeName="Car"), a=4, b=6))
    assert _ends(result, "S4") == [("Car-001", "06:26"), ("Car-002", "06:46")]
    assert sorted(result["simulation_state"]["assemblies"]["Car-001"]["parts"]) == ["a-002", "b-001", "b-002", "b-003"]


def test_assembly_main_line_amount_counts_in_the_warning():
    # 5 bodies at 2 per car, 6 wheels at 3 per car: 2 cars, 1 body left over.
    result, _ = _run_sim(*_assembly_line(_two_bodies(), a=5, b=6))
    assert result["simulation_state"]["warnings"] == [
        "ASM: parts for only 2 assemblies — 1 main parts can never be used."]


# ── Dismantle ────────────────────────────────────────────────────────────────
# a (3 jobs, all at once): S1 (2 min) -> DIS (2 min) -> R (3 min) or W (1 min).
# DIS set to FEs to all Successors: every job splits into one piece for R and
# one for W. No station has a buffer, so DIS keeps a job until both its pieces
# have been taken.

def _dismantle_line(dismantle, two_routes=False):
    stations = {
        "S1": _station(operator_per_station=0),
        "DIS": _station(operator_per_station=0, **({"Station Type": "Dismantle"}),
                        **({"Dismantle": dismantle} if dismantle is not None else {})),
        "R": _station(operator_per_station=0),
        "W": _station(operator_per_station=0),
    }
    head = [{"operation": "S1", "resource": "S1", "duration": 2.0},
            {"operation": "DIS", "resource": "DIS", "duration": 2.0}]
    if two_routes:
        # R on a's route, W on b's: still both of DIS's next stations.
        flow = {"a": head + [{"operation": "R", "resource": "R", "duration": 3.0}],
                "b": head + [{"operation": "W", "resource": "W", "duration": 1.0}]}
        return stations, flow, {"a": 3, "b": 0}
    flow = {"a": head + [{"operation": "R", "resource": "R", "duration": 3.0, "branch": 1},
                         {"operation": "W", "resource": "W", "duration": 1.0, "branch": 1}]}
    return stations, flow, {"a": 3}


def _dis(**over):
    cfg = {"sequence": "all_successors", "mode": "create_fe", "mainFeToSuccessor": 1, "exitingFe": "main_fe"}
    cfg.update(over)
    return cfg


def test_dismantle_create_fe_one_piece_per_next_station():
    # a-002's R piece waits until R is free at 7, so DIS holds a-002 until 7:
    # a-003 (ready at 6) only gets DIS 7-9. New FE with no name: "a A" —
    # but line 1 (R, Main FE to Successor) keeps the part's name.
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe")))
    assert _ends(result, "DIS") == [("a-001", "06:04"), ("a-002", "06:06"), ("a-003", "06:09")]
    assert _ends(result, "R") == [("a-001", "06:07"), ("a-002", "06:10"), ("a-003", "06:13")]
    assert _ends(result, "W") == [("a A-001", "06:05"), ("a A-002", "06:07"), ("a A-003", "06:10")]
    state = result["simulation_state"]
    # Counted once per dismantled job.
    assert state["completed_jobs"] == 3
    assert state["in_progress_jobs"] == 0
    assert state["dismantles"]["a-002"] == {"station": "DIS", "mode": "create", "pieces": ["a-002", "a A-002"]}


@pytest.mark.parametrize("mode", ["create_fe", "detach_fe"])
def test_dismantle_main_fe_keeps_the_name(mode):
    # Exiting FE = Main FE: every piece keeps the job's name (both modes).
    result, _ = _run_sim(*_dismantle_line(_dis(mode=mode)))
    assert _ends(result, "R") == [("a-001", "06:07"), ("a-002", "06:10"), ("a-003", "06:13")]
    assert _ends(result, "W") == [("a-001-2", "06:05"), ("a-002-2", "06:07"), ("a-003-2", "06:10")]
    assert result["simulation_state"]["completed_jobs"] == 3


def test_dismantle_detach_new_fe_gives_every_piece_the_name():
    result, _ = _run_sim(*_dismantle_line(_dis(mode="detach_fe", exitingFe="new_fe", newFeName="Body")))
    assert [j for j, _ in _ends(result, "R")] == ["Body-001", "Body-003", "Body-005"]
    assert [j for j, _ in _ends(result, "W")] == ["Body-002", "Body-004", "Body-006"]


def test_dismantle_next_stations_from_every_route():
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe"), two_routes=True))
    assert [j for j, _ in _ends(result, "R")] == ["a-001", "a-002", "a-003"]
    assert [j for j, _ in _ends(result, "W")] == ["a A-001", "a A-002", "a A-003"]
    assert result["simulation_state"]["completed_jobs"] == 3


def test_dismantle_without_settings_is_a_plain_station():
    # No panel settings saved: no pieces, R or W per job.
    result, _ = _run_sim(*_dismantle_line(None))
    jobs = [j for st in ("R", "W") for j, _ in _ends(result, st)]
    assert sorted(jobs) == ["a-001", "a-002", "a-003"]
    assert result["simulation_state"]["dismantles"] == {}


# Dismantle input configuration: the Dismantle table.

def _table(r=(1, 1), w=(1, 2)):
    return [{"to": "R", "number": r[0], "successor": r[1]},
            {"to": "W", "number": w[0], "successor": w[1]}]


def test_dismantle_table_pieces_leave_in_successor_order():
    # R first, then W. a-002's pieces at 6: R is busy until 7, so its piece
    # waits — and W's (W free) waits for it: W 7-8, not 6-7. a-003: DIS 7-9;
    # R free at 10, W's piece after it: 10-11. Main FE: the job's name.
    result, _ = _run_sim(*_dismantle_line(_dis(sequence="input_config", table=_table())))
    assert _ends(result, "DIS") == [("a-001", "06:04"), ("a-002", "06:06"), ("a-003", "06:09")]
    assert _ends(result, "R") == [("a-001", "06:07"), ("a-002", "06:10"), ("a-003", "06:13")]
    assert _ends(result, "W") == [("a-001-2", "06:05"), ("a-002-2", "06:08"), ("a-003-2", "06:11")]
    assert result["simulation_state"]["completed_jobs"] == 3


def test_dismantle_table_successor_first_goes_first():
    # W is Successor 1: its piece leaves first, R's after it.
    result, _ = _run_sim(*_dismantle_line(_dis(sequence="input_config", table=_table(r=(1, 2), w=(1, 1)))))
    assert result["simulation_state"]["dismantles"]["a-001"]["pieces"] == ["a-001", "a-001-2"]
    assert [j for j, _ in _ends(result, "W")][0] == "a-001"


def test_dismantle_table_number_and_names():
    # Number 2 to R: 2 pieces there per job. New FE: every piece gets the
    # New FE name, as with FEs to all Successors.
    result, _ = _run_sim(*_dismantle_line(_dis(sequence="input_config", exitingFe="new_fe", newFeName="Body",
                                               table=_table(r=(2, 1), w=(1, 2)))))
    state = result["simulation_state"]
    assert state["dismantles"]["a-001"]["pieces"] == ["Body-001", "Body-002", "Body-003"]
    assert len(_ends(result, "R")) == 6 and len(_ends(result, "W")) == 3
    assert state["completed_jobs"] == 3
    assert state["in_progress_jobs"] == 0


@pytest.mark.parametrize("table, message", [
    (None, "DIS: fill in the Dismantle table (Sequence is Dismantle input configuration)."),
    (_table(r=(0, 1)), "DIS: Number for R must be a whole number, 1 or more."),
    (_table(w=(1, 3)), "DIS: Successor for W must be from 1 to 2."),
    ([{"to": "X", "number": 1, "successor": 1}],
     "DIS: no route goes from it to X — draw that line for a product, or remove the row."),
])
def test_dismantle_table_problems_stop_the_run(table, message):
    with pytest.raises(ValueError) as err:
        _run_sim(*_dismantle_line(_dis(sequence="input_config", **({"table": table} if table else {}))))
    assert str(err.value) == message


# FEs to all Successors + Create FE + New FE: the line Main FE to Successor
# names keeps the part's name; the lines are numbered as connected.

def test_dismantle_main_line_keeps_the_name():
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="TYRE", mainFeToSuccessor=2,
                                               successors=["R", "W"])))
    assert [j for j, _ in _ends(result, "R")] == ["TYRE-001", "TYRE-002", "TYRE-003"]
    assert [j for j, _ in _ends(result, "W")] == ["a-001", "a-002", "a-003"]


def test_dismantle_lines_numbered_as_connected():
    # W connected first: it is line 1.
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="TYRE", mainFeToSuccessor=1,
                                               successors=["W", "R"])))
    assert [j for j, _ in _ends(result, "W")] == ["a-001", "a-002", "a-003"]
    assert [j for j, _ in _ends(result, "R")] == ["TYRE-001", "TYRE-002", "TYRE-003"]


@pytest.mark.parametrize("over", [{"mode": "detach_fe"}, {"sequence": "input_config", "table": _table()}])
def test_dismantle_main_line_rule_only_for_create_all_successors(over):
    # Detach FE / Dismantle input configuration: every piece gets the name.
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="TYRE", mainFeToSuccessor=2,
                                               successors=["R", "W"], **over)))
    jobs = [j for st in ("R", "W") for j, _ in _ends(result, st)]
    assert all(j.startswith("TYRE-") for j in jobs) and len(jobs) == 6


def test_dismantle_main_line_more_than_the_lines_stops_the_run():
    with pytest.raises(ValueError) as err:
        _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="TYRE", mainFeToSuccessor=3)))
    assert str(err.value) == "DIS: Main FE to Successor is 3, but only 2 lines go out."


def test_dismantle_worker_time_called_until_parts_separated():
    # Op1 (Worker Controller WC1) works the Dismantle: called when a part is
    # on it, released when the parts are separated — 2 min per job, even when
    # a piece then waits for R (a-002: released at 6, R takes it at 7).
    stations, flow, qty = _dismantle_line(_dis(exitingFe="new_fe", newFeName="TYRE"))
    stations["DIS"]["Worker Controller"] = "WC1"
    stations["WC1"] = _station(operator_per_station=0, **{
        "Station Type": "Worker Controller", "Pool Workers": [_pool_worker("Op1")]})
    result, _ = _run_sim(stations, flow, qty)
    [op1] = result["worker_pool_stats"]["WC1"]["workers"]
    assert op1["name"] == "Op1"
    assert op1["worked_time"] == pytest.approx(6.0)
    assert op1["jobs"] == 3
    assert op1["utilization"] == pytest.approx(6.0 / 480 * 100)
    assert op1["workplaces"] == [{"station": "DIS", "worked_time": pytest.approx(6.0), "jobs": 3}]
    # Everything else as before.
    assert _ends(result, "DIS") == [("a-001", "06:04"), ("a-002", "06:06"), ("a-003", "06:09")]


def test_worker_time_leaves_out_walking():
    # Travel Time 15 only when reassigned (WP_A then WP_B): worked = 10 + 10.
    stations = {
        "WP_A": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP_B": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WC": _station(operator_per_station=0, **{
            "Station Type": "Worker Controller", "Pool Workers": [_pool_worker(travel_time=15.0)]}),
    }
    flow = {"a": [{"operation": "A", "resource": "WP_A", "duration": 10.0},
                  {"operation": "B", "resource": "WP_B", "duration": 10.0}]}
    result, _ = _run_sim(stations, flow, {"a": 1})
    [w1] = result["worker_pool_stats"]["WC"]["workers"]
    assert w1["worked_time"] == pytest.approx(20.0)
    assert {p["station"]: p["worked_time"] for p in w1["workplaces"]} == {"WP_A": pytest.approx(10.0), "WP_B": pytest.approx(10.0)}


def _worker_with_breakdowns(policy):
    # A breaks down often (MTBF 30, Repair Time 5); one pooled Worker on it.
    stations = {
        "A": _station(operator_per_station=1, **{"Worker Controller": "WC", "MTBF": 30.0,
                                                 "Repair Time": 5, "Failure Policy": policy}),
        "WC": _station(operator_per_station=0, **{"Station Type": "Worker Controller", "Pool Workers": [_pool_worker()]}),
    }
    result, _ = _run_sim(stations, {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]}, {"a": 10})
    statuses = [e["status"] for e in result["completion_log"]["A"]]
    [w1] = result["worker_pool_stats"]["WC"]["workers"]
    return statuses, w1


def test_worker_time_counts_a_breakdown_during_the_job():
    # The Worker stays on the job while A is repaired: 10 jobs of 10 min, and
    # the repair time on top counts as worked.
    statuses, w1 = _worker_with_breakdowns("resume")
    assert statuses.count("Completed") == 10
    assert w1["jobs"] == 10
    assert w1["worked_time"] > 10 * 10.0


def test_worker_jobs_count_a_scrapped_part():
    # A part scrapped mid-job still counts as one job for the Worker.
    statuses, w1 = _worker_with_breakdowns("scrap")
    assert statuses.count("Scrapped") >= 1
    assert w1["jobs"] == statuses.count("Completed") + statuses.count("Scrapped") == 10


def test_assembly_worker_called_only_when_every_part_is_there():
    # The body is on ASM from 10 but its wheel comes at 20: Op1 is called at
    # 20 (not 10), works 20-25 and is released when the Car is made.
    stations, flow, qty = _assembly_line(_asm(mode="attach_mus", exitingMu="new_fe", newFeName="Car"), wheel_time=20.0)
    stations["ASM"]["Worker Controller"] = "WC1"
    stations["WC1"] = _station(operator_per_station=0, **{
        "Station Type": "Worker Controller", "Pool Workers": [_pool_worker("Op1")]})
    result, _ = _run_sim(stations, flow, qty)
    a1 = [e for e in result["completion_log"]["ASM"] if e["job_id"] == "a-001"][0]
    assert a1["Waiting for parts"] == pytest.approx(10.0)
    assert (a1["process_start_time_real"][11:16], a1["process_end_time_real"][11:16]) == ("06:20", "06:25")
    [op1] = result["worker_pool_stats"]["WC1"]["workers"]
    # Only the 5 min of work per Car — never the wait for parts.
    assert op1["worked_time"] == pytest.approx(10.0)
    assert op1["jobs"] == 2
    assert _ends(result, "S4") == [("Car-001", "06:26"), ("Car-002", "06:46")]


# ── Statistical analysis per station (state_stats) ──────────────────────────
# Working / Free / Setup / Blocked / Failed % of the operating time (shift
# time minus breaks and PM); the five always add up to 100.

def _minutes(result, station):
    s = result["station_states"][station]
    assert s["working"] + s["free"] + s["setup"] + s["blocked"] + s["failed"] == pytest.approx(100.0)
    return {k: round(s[k] / 100 * s["operating_time"], 6) for k in ("working", "free", "setup", "blocked", "failed")}


def _sim(stations, flow, quantities, **cfg_over):
    cfg = dict(SIM_CONFIG)
    cfg.update(cfg_over)
    random.seed(0)
    sim = ManufacturingSimulation(stations, flow, quantities, {}, cfg)
    return sim.run(), sim


def test_station_states_working_blocked_free():
    # A 2 min -> B 10 min, no buffer, 3 jobs, one 480-min shift. A: works
    # 3 x 2 min; a-002 and a-003 each wait 8 min for B (blocked).
    stations = {"A": _station(operator_per_station=0), "B": _station(operator_per_station=0)}
    flow = {"a": [{"operation": "A", "resource": "A", "duration": 2.0},
                  {"operation": "B", "resource": "B", "duration": 10.0}]}
    result, _ = _sim(stations, flow, {"a": 3}, SIM_TIME=480.0)
    assert result["station_states"]["A"]["operating_time"] == pytest.approx(480.0)
    assert _minutes(result, "A") == {"working": 6.0, "free": 458.0, "setup": 0.0, "blocked": 16.0, "failed": 0.0}
    assert _minutes(result, "B") == {"working": 30.0, "free": 450.0, "setup": 0.0, "blocked": 0.0, "failed": 0.0}


def test_station_states_setup_and_shift_only():
    # 24 h run, Shift 1 only: the 16 closed hours are left out (480 min).
    stations = {"A": _station(operator_per_station=0, **{"Setup time": 5})}
    result, _ = _sim(stations, {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]}, {"a": 3}, SIM_TIME=1440.0)
    assert result["station_states"]["A"]["operating_time"] == pytest.approx(480.0)
    assert _minutes(result, "A") == {"working": 30.0, "free": 445.0, "setup": 5.0, "blocked": 0.0, "failed": 0.0}


def test_station_states_breaks_and_pm_left_out():
    # A 30-min break: 450 min. Weekly PM (10 min, 7 days after the start,
    # inside the shift): left out too, and not Failed.
    flow = {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]}
    result, _ = _sim({"A": _station(operator_per_station=0)}, flow, {"a": 3},
                     SIM_TIME=480.0, BREAKS_1=[{"start": 10.0, "duration": 30}])
    assert result["station_states"]["A"]["operating_time"] == pytest.approx(450.0)
    result, _ = _sim({"A": _station(operator_per_station=0, **{"PM Schedule": "Weekly"})}, flow, {"a": 3},
                     SIM_TIME=14 * 1440.0)
    # 10 working days (from a Wednesday) x 480, minus the 10-min PM.
    assert result["station_states"]["A"]["operating_time"] == pytest.approx(4790.0)
    assert result["station_states"]["A"]["failed"] == 0.0


def test_station_states_failed_is_the_breakdowns_in_shift():
    from backend.engine.state_stats import shift_time, merge, overlap
    stations = {"A": _station(operator_per_station=0, **{"MTBF": 60.0, "Repair Time": 10})}
    result, sim = _sim(stations, {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]}, {"a": 40},
                       SIM_TIME=3 * 1440.0)
    sm = sim.resources["A"].sub_machines[0]
    breakdowns = merge([(a, b) for kind, a, b, _ in sm.downtime_log if kind == "Failure"]
                       + ([(sm.failure_start_time, 3 * 1440.0)] if sm.failure_start_time is not None else []))
    shifts = shift_time(sim._station_shift_cfg.get("A", sim.sim_config), 1,
                        result["simulation_state"]["start_date"], 3 * 1440.0)
    minutes = _minutes(result, "A")
    assert minutes["failed"] > 0
    assert minutes["failed"] == pytest.approx(overlap(breakdowns, shifts))
    assert minutes["working"] == pytest.approx(400.0)


def test_station_states_assembly_waiting_for_parts_is_free():
    # The body waits 10 + 10 min on ASM for its wheels: Free, not Working.
    result, _ = _run_sim(*_assembly_line(_asm(mode="attach_mus", exitingMu="new_fe", newFeName="Car"),
                                         wheel_time=20.0), sim_time=480.0)
    assert _minutes(result, "ASM") == {"working": 10.0, "free": 470.0, "setup": 0.0, "blocked": 0.0, "failed": 0.0}
    assert "Start" not in result["station_states"]


def test_station_states_dismantle_blocked_until_pieces_taken():
    # a-002's and a-003's R pieces each wait 1 min for R: DIS blocked 2 min.
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="T")), sim_time=480.0)
    assert _minutes(result, "DIS") == {"working": 6.0, "free": 472.0, "setup": 0.0, "blocked": 2.0, "failed": 0.0}


def test_station_states_measured_after_the_warm_up():
    # Like the other KPIs: only after WARMUP_TIME (60 of 480 min). A job every
    # 20 min (0, 20, ... 160): the 6 from 60 on count, 10 min each.
    cfg = dict(SIM_CONFIG)
    cfg.update(SIM_TIME=480.0, WARMUP_TIME=60.0)
    random.seed(0)
    result = ManufacturingSimulation({"A": _station(operator_per_station=0)},
                                     {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]},
                                     {"a": 9}, {}, cfg, variant_intervals={"a": 20.0}).run()
    assert result["station_states"]["A"]["operating_time"] == pytest.approx(420.0)
    assert _minutes(result, "A")["working"] == pytest.approx(60.0)


def _parts(result, station):
    s = result["station_states"][station]
    return {k: s[k] for k in ("current_parts", "completed_parts", "scrapped_parts", "output_components")}


def test_station_parts_current_on_the_machine_not_the_queue():
    # A (1 min) -> B (100 min), 10 jobs, 480 min: at the end A holds one
    # finished part B can't take yet, B works on one; the rest queue at A
    # (not counted). B finished 4.
    stations = {"A": _station(operator_per_station=0), "B": _station(operator_per_station=0)}
    flow = {"a": [{"operation": "A", "resource": "A", "duration": 1.0},
                  {"operation": "B", "resource": "B", "duration": 100.0}]}
    result, _ = _sim(stations, flow, {"a": 10}, SIM_TIME=480.0)
    assert _parts(result, "A") == {"current_parts": 1, "completed_parts": 6, "scrapped_parts": 0, "output_components": None}
    assert _parts(result, "B") == {"current_parts": 1, "completed_parts": 4, "scrapped_parts": 0, "output_components": None}


def test_station_parts_scrap_counted_apart():
    stations = {"A": _station(operator_per_station=0, **{"MTBF": 30.0, "Repair Time": 5, "Failure Policy": "scrap"})}
    result, _ = _sim(stations, {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]}, {"a": 10}, SIM_TIME=480.0)
    statuses = [e["status"] for e in result["completion_log"]["A"]]
    parts = _parts(result, "A")
    assert parts["scrapped_parts"] == statuses.count("Scrapped") >= 1
    assert parts["completed_parts"] == statuses.count("Completed")
    assert parts["completed_parts"] + parts["scrapped_parts"] == 10


def test_station_parts_dismantle_counts_the_car_once():
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="T")), sim_time=480.0)
    assert _parts(result, "DIS") == {"current_parts": 0, "completed_parts": 3, "scrapped_parts": 0, "output_components": 6}


def test_station_parts_after_the_warm_up():
    # 9 jobs end at 10, 20, ... 90; warm-up 60: the 4 from 60 on count.
    result, _ = _sim({"A": _station(operator_per_station=0)},
                     {"a": [{"operation": "A", "resource": "A", "duration": 10.0}]}, {"a": 9},
                     SIM_TIME=480.0, WARMUP_TIME=60.0)
    assert _parts(result, "A")["completed_parts"] == 4


# Buffer statistical analysis: Empty / Occupied / Full = 100%.

def _buffer_states_line(capacity, unlimited=False):
    stations = {"A": _station(operator_per_station=0),
                "BUF": _station(operator_per_station=0, **{"Station Type": "Buffer", "Buffer Capacity": capacity,
                                                          "Buffer Unlimited": unlimited}),
                "B": _station(operator_per_station=0)}
    flow = {"a": [{"operation": "A", "resource": "A", "duration": 1.0},
                  {"operation": "BUF", "resource": "BUF", "duration": 0.0},
                  {"operation": "B", "resource": "B", "duration": 10.0}]}
    result, _ = _sim(stations, flow, {"a": 8}, SIM_TIME=480.0)
    s = result["buffer_states"]["BUF"]
    assert s["empty"] + s["occupied"] + s["full"] == pytest.approx(100.0)
    assert s["operating_time"] == pytest.approx(480.0)
    return {k: round(s[k] / 100 * 480, 6) for k in ("empty", "occupied", "full")}


def test_buffer_states_empty_occupied_full():
    # A fills the box (1 min a part) faster than B empties it (10 min).
    assert _buffer_states_line(2) == {"empty": 411.0, "occupied": 11.0, "full": 58.0}
    assert _buffer_states_line(5) == {"empty": 411.0, "occupied": 44.0, "full": 25.0}


def test_buffer_states_unlimited_is_never_full():
    assert _buffer_states_line(0, unlimited=True) == {"empty": 411.0, "occupied": 69.0, "full": 0.0}


# Start: parts delivered / End: parts collected (parts_flow), after warm-up.

def test_parts_flow_assembly_delivers_parts_collects_cars():
    result, _ = _run_sim(*_assembly_line(_asm(mode="attach_mus", exitingMu="new_fe", newFeName="Car")), sim_time=480.0)
    assert result["parts_flow"] == {"delivered": {"Start": {"a": 2}, "Start 2": {"b": 2}},
                                    "collected": {"S4": {"a": {"Car": 2}}}}


def test_parts_flow_dismantle_collects_every_piece():
    # 3 jobs in; 3 pieces leave R (route a, main line keeps "a"), 3 leave W
    # ("T"), each on the route of its own line.
    result, _ = _run_sim(*_dismantle_line(_dis(exitingFe="new_fe", newFeName="T"), two_routes=True), sim_time=480.0)
    assert result["parts_flow"]["collected"] == {"R": {"a": {"a": 3}}, "W": {"b": {"T": 3}}}
    assert sum(result["parts_flow"]["delivered"][""].values()) == 3


def test_parts_flow_after_the_warm_up():
    # a and b released at 0, 30, 60, 90; warm-up 60: the last two of each.
    cfg = dict(SIM_CONFIG)
    cfg.update(SIM_TIME=480.0, WARMUP_TIME=60.0)
    random.seed(0)
    flow = {p: [{"operation": "A", "resource": "A", "duration": 10.0}] for p in ("a", "b")}
    result = ManufacturingSimulation({"A": _station(operator_per_station=0)}, flow, {"a": 4, "b": 4}, {}, cfg,
                                     variant_intervals={"a": 30.0, "b": 30.0}).run()
    assert result["parts_flow"] == {"delivered": {"": {"a": 2, "b": 2}}, "collected": {"A": {"a": {"a": 2}, "b": {"b": 2}}}}


# Worker statistical analysis: Working / Free % of its available time (the
# Worker Controller's shift minus time away, after the warm-up).

def _dismantle_with_worker(controller=None, **cfg_over):
    stations, flow, qty = _dismantle_line(_dis(exitingFe="new_fe", newFeName="T"))
    stations["DIS"]["Worker Controller"] = "WC"
    stations["WC"] = _station(operator_per_station=0, **{"Station Type": "Worker Controller",
                                                         "Pool Workers": [_pool_worker("Op1")], **(controller or {})})
    result, sim = _sim(stations, flow, qty, **{"SIM_TIME": 480.0, **cfg_over})
    [w] = result["worker_pool_stats"]["WC"]["workers"]
    assert w["working_pct"] + w["free_pct"] == pytest.approx(100.0)
    return w, sim


def test_worker_working_and_free_of_the_controller_shift():
    # Op1 works 3 x 2 min (06:02-06:10). No shift set: all 480 min; Shift
    # 6-8 (clock time, the run starts at 06:00): 120 min.
    w, _ = _dismantle_with_worker()
    assert (w["available_time"], w["working_pct"]) == (pytest.approx(480.0), pytest.approx(6 / 480 * 100))
    w, _ = _dismantle_with_worker({"Shift Start": 6, "Shift End": 8})
    assert (w["available_time"], w["working_pct"]) == (pytest.approx(120.0), pytest.approx(5.0))


def test_worker_time_away_left_out_and_warm_up():
    w, sim = _dismantle_with_worker({"Pool Workers": [_pool_worker("Op1", availability=50.0)]})
    away = sum(b - a for a, b in sim.worker_pools["WC"].time_log["Op1"]["away"])
    assert away > 0
    assert w["available_time"] == pytest.approx(480.0 - away)
    # Warm-up 5: Op1 worked 2-4, 4-6, 7-9 -> 1 + 2 min after it, of 475.
    w, _ = _dismantle_with_worker(WARMUP_TIME=5.0)
    assert (w["available_time"], w["working_pct"]) == (pytest.approx(475.0), pytest.approx(3 / 475 * 100))


def test_worker_walking_counts_as_free():
    stations = {
        "WP_A": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WP_B": _station(operator_per_station=1, **{"Worker Controller": "WC"}),
        "WC": _station(operator_per_station=0, **{"Station Type": "Worker Controller",
                                                  "Pool Workers": [_pool_worker(travel_time=15.0)]}),
    }
    flow = {"a": [{"operation": "A", "resource": "WP_A", "duration": 10.0},
                  {"operation": "B", "resource": "WP_B", "duration": 10.0}]}
    result, _ = _sim(stations, flow, {"a": 1}, SIM_TIME=480.0)
    [w] = result["worker_pool_stats"]["WC"]["workers"]
    assert w["working_pct"] == pytest.approx(20 / 480 * 100)


def test_worker_controller_shift_is_clock_time():
    # Shift Start/End are clock hours: the run starts at 06:00, so a 12-14
    # shift opens 6 h in — the first part waits until 12:00 for Op1.
    w, _ = _dismantle_with_worker({"Shift Start": 12, "Shift End": 14})
    assert w["available_time"] == pytest.approx(120.0)
    stations, flow, qty = _dismantle_line(_dis(exitingFe="new_fe", newFeName="T"))
    stations["DIS"]["Worker Controller"] = "WC"
    stations["WC"] = _station(operator_per_station=0, **{"Station Type": "Worker Controller",
                                                         "Pool Workers": [_pool_worker("Op1")],
                                                         "Shift Start": 12, "Shift End": 14})
    result, _ = _sim(stations, flow, qty, SIM_TIME=480.0)
    first = [e for e in result["completion_log"]["DIS"] if e["job_id"] == "a-001"][0]
    # The part is on DIS from 06:02; Op1 is called at exactly 12:00, when
    # the shift opens, so the 2 min of work end at 12:02.
    assert first["process_end_time_real"][11:16] == "12:02"


def test_last_buffer_without_end_keeps_parts():
    # Station 1 (5 min) -> Buffer 1 (room 3), no End: parts stay in the
    # buffer and count as finished. Once 3 are in it, Station 1 is blocked.
    stations = {
        "Station 1": _station(operator_per_station=0, **{"Enable Failures": False}),
        "Buffer 1": _station(operator_per_station=0, **{"Station Type": "Buffer", "Buffer Capacity": 3}),
    }
    flow = {"v": [{"operation": "a", "resource": "Station 1", "duration": 5.0},
                  {"operation": "b", "resource": "Buffer 1", "duration": 0.0, "holds_parts": True}]}
    result, sim = _run_sim(stations, flow, {"v": 10}, sim_time=100.0)
    assert result["simulation_state"]["completed_jobs"] == 3
    b = result["buffer_states"]["Buffer 1"]
    assert b["current_parts"] == 3 and b["completed_parts"] == 0
    assert result["station_states"]["Station 1"]["blocked"] > 0


def test_last_buffer_with_end_still_lets_parts_go():
    # Same line, Buffer 1 -> End (no holds_parts): parts leave, all 10 finish.
    stations = {
        "Station 1": _station(operator_per_station=0, **{"Enable Failures": False}),
        "Buffer 1": _station(operator_per_station=0, **{"Station Type": "Buffer", "Buffer Capacity": 3}),
    }
    flow = {"v": [{"operation": "a", "resource": "Station 1", "duration": 5.0},
                  {"operation": "b", "resource": "Buffer 1", "duration": 0.0}]}
    result, _ = _run_sim(stations, flow, {"v": 10}, sim_time=100.0)
    assert result["simulation_state"]["completed_jobs"] == 10


def test_start_alone_counts_parts_as_finished():
    # Only a Start (no steps): each part counts as finished when released.
    stations = {"Start": _station(operator_per_station=0, **{"Station Type": "Source"})}
    result, _ = _run_sim(stations, {"v": []}, {"v": 10}, sim_time=480.0)
    assert result["simulation_state"]["completed_jobs"] == 10


def test_line_ending_at_a_station_without_end():
    # Start -> Station 1, nothing after: a part is finished when it leaves Station 1.
    stations = {"Station 1": _station(operator_per_station=0, **{"Enable Failures": False})}
    flow = {"v": [{"operation": "a", "resource": "Station 1", "duration": 5.0}]}
    result, _ = _run_sim(stations, flow, {"v": 10}, sim_time=480.0)
    assert result["simulation_state"]["completed_jobs"] == 10
