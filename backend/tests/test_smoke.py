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
