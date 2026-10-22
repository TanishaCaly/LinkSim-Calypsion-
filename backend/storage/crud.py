"""
CRUD helpers — keep all DB logic out of route handlers.
"""
import json
from datetime import datetime, date
from typing import Dict, List, Optional, Any


def _json_safe(obj: Any) -> Any:
    """Recursively convert non-JSON-serialisable values (datetime, etc.) to strings."""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj

from sqlalchemy.orm import Session

from .models import Scenario, SimulationRun, StationStat


# ---------------------------------------------------------------------------
# Scenario
# ---------------------------------------------------------------------------

def create_scenario(db: Session, payload: Dict[str, Any], user_id: Optional[int] = None) -> Scenario:
    scenario = Scenario(
        user_id=user_id,
        name=payload["name"],
        description=payload.get("description"),
        stations_data=payload.get("stations_data", {}),
        processflow_data=payload.get("processflow_data", {}),
        variant_quantities=payload.get("variant_quantities", {}),
        variant_intervals=payload.get("variant_intervals", {}),
        setup_matrix=payload.get("setup_matrix", {}),
        operators_data=payload.get("operators_data", {}),
        simulation_config=payload.get("simulation_config", {}),
        source_filename=payload.get("source_filename"),
        source_file=bytes(payload["source_file"]) if payload.get("source_file") else None,
    )
    db.add(scenario)
    db.commit()
    db.refresh(scenario)
    return scenario


def get_scenario(db: Session, scenario_id: int, user_id: Optional[int] = None) -> Optional[Scenario]:
    q = db.query(Scenario).filter(Scenario.id == scenario_id)
    if user_id is not None:
        q = q.filter(Scenario.user_id == user_id)
    return q.first()


def list_scenarios(db: Session, skip: int = 0, limit: int = 50, user_id: Optional[int] = None) -> List[Scenario]:
    q = db.query(Scenario)
    if user_id is not None:
        q = q.filter(Scenario.user_id == user_id)
    return q.order_by(Scenario.created_at.desc()).offset(skip).limit(limit).all()


def count_scenarios(db: Session, user_id: Optional[int] = None) -> int:
    q = db.query(Scenario)
    if user_id is not None:
        q = q.filter(Scenario.user_id == user_id)
    return q.count()


def update_scenario(db: Session, scenario_id: int, payload: Dict[str, Any], user_id: Optional[int] = None) -> Optional[Scenario]:
    scenario = get_scenario(db, scenario_id, user_id=user_id)
    if not scenario:
        return None
    for key, val in payload.items():
        if hasattr(scenario, key):
            setattr(scenario, key, val)
    scenario.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(scenario)
    return scenario


def delete_scenario(db: Session, scenario_id: int, user_id: Optional[int] = None) -> bool:
    scenario = get_scenario(db, scenario_id, user_id=user_id)
    if not scenario:
        return False
    db.delete(scenario)
    db.commit()
    return True


# ---------------------------------------------------------------------------
# SimulationRun
# ---------------------------------------------------------------------------

def create_run(db: Session, scenario_id: int, num_replications: int = 1) -> SimulationRun:
    run = SimulationRun(scenario_id=scenario_id, num_replications=num_replications)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def get_run(db: Session, run_id: int) -> Optional[SimulationRun]:
    return db.query(SimulationRun).filter(SimulationRun.id == run_id).first()


def list_runs(db: Session, scenario_id: int) -> List[SimulationRun]:
    return (
        db.query(SimulationRun)
        .filter(SimulationRun.scenario_id == scenario_id)
        .order_by(SimulationRun.created_at.desc())
        .all()
    )


def mark_run_running(db: Session, run_id: int) -> Optional[SimulationRun]:
    run = get_run(db, run_id)
    if run:
        run.status = "running"
        db.commit()
    return run


def complete_run(db: Session, run_id: int, result: Dict[str, Any], status: str = "completed") -> Optional[SimulationRun]:
    run = get_run(db, run_id)
    if not run:
        return None

    run.status = status
    run.completed_at = datetime.utcnow()
    run.result = _json_safe(result)

    sim_state = result.get("simulation_state", {})
    run.completed_jobs = sim_state.get("completed_jobs")
    run.in_progress_jobs = sim_state.get("in_progress_jobs", 0)
    run.simulation_time = sim_state.get("total_simulated_time")

    summary = sim_state.get("summary", {})
    run.kpi_throughput = summary.get("throughput")
    run.kpi_avg_utilization = summary.get("avg_utilization")
    run.kpi_peak_utilization = summary.get("peak_utilization")
    run.kpi_bottleneck_station = summary.get("bottleneck_station")
    run.kpi_stations_at_risk = summary.get("stations_at_risk")
    run.kpi_total_failures = summary.get("total_failures")
    run.kpi_avg_rework_pct = summary.get("avg_rework_pct")
    run.kpi_sim_days = summary.get("sim_days")

    # Persist per-station summary rows
    station_stats = result.get("station_stats", {})
    bottleneck_store = result.get("bottleneck_store", {})
    for name, stats in station_stats.items():
        top_bn = _top_bottleneck(bottleneck_store.get(name, {}))
        db.add(StationStat(
            run_id=run.id,
            station_name=name,
            station_utilization=stats.get("station_utilization", 0),
            operator_utilization=stats.get("operator_utilization", 0),
            rework_percentage=stats.get("rework_percentage", 0),
            rework_time_ratio=stats.get("rework_time_ratio", 0.0),
            setup_time_ratio=stats.get("setup_time_ratio", 0.0),
            total_setup_time=stats.get("total_setup_time", 0.0),
            buffer_blocked_ratio=stats.get("buffer_blocked_ratio", 0.0),
            buffer_blocked_time=stats.get("buffer_blocked_time", 0.0),
            buffer_capacity=stats.get("buffer_capacity", 0),
            buffer_discipline=stats.get("buffer_discipline", "FIFO"),
            rack_lane_count=stats.get("rack_lane_count"),
            rack_occupied=stats.get("rack_occupied"),
            completed_jobs=stats.get("completed_jobs", 0),
            throughput=stats.get("throughput", 0.0),
            busy_time=stats.get("busy_time", 0),
            avg_block_time=stats.get("avg_block_time", 0),
            failure_breakdowns=stats.get("failure_breakdowns", 0),
            failure_counts_per_machine=stats.get("failure_counts_per_machine"),
            pm_breakdowns=stats.get("pm_breakdowns", 0),
            operator_per_station=stats.get("operator_per_station", 1),
            capacity=stats.get("capacity", 1),
            conveyor_length=stats.get("conveyor_length"),
            conveyor_speed=stats.get("conveyor_speed"),
            transport_time=stats.get("transport_time"),
            sensor_passed=stats.get("sensor_passed"),
            top_bottleneck_type=top_bn.get("type"),
            top_bottleneck_metric=top_bn.get("metric"),
            avg_cycle_time=stats.get("avg_cycle_time", 0.0),
            max_cycle_time=stats.get("max_cycle_time", 0.0),
        ))

    db.commit()
    db.refresh(run)
    return run


def fail_run(db: Session, run_id: int, error: str) -> Optional[SimulationRun]:
    run = get_run(db, run_id)
    if run:
        run.status = "failed"
        run.error_message = error
        run.completed_at = datetime.utcnow()
        db.commit()
    return run


def get_station_stats(db: Session, run_id: int) -> List[StationStat]:
    return db.query(StationStat).filter(StationStat.run_id == run_id).all()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _top_bottleneck(bottleneck_info: Dict) -> Dict:
    bottlenecks = bottleneck_info.get("bottlenecks", [])
    return bottlenecks[0] if bottlenecks else {}
