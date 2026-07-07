"""
KPI Formulas — single source of truth for all simulation metrics.

To change any formula, edit ONLY this file.
All other modules (sim_core, bottleneck, machine, ai_insights) import from here.
"""

from typing import Dict, Any, List, Optional


# ── Thresholds ────────────────────────────────────────────────────────────────

AT_RISK_UTILIZATION_THRESHOLD    = 80   # % — stations at or above are "at risk"
BOTTLENECK_UTILIZATION_THRESHOLD = 85   # % — stations at or above are bottlenecks
SYSTEM_CONSTRAINT_RATIO          = 0.6  # fraction of stations above bottleneck threshold to flag system-wide constraint
OPERATOR_TARGET_UTILIZATION      = 75   # % — target util when calculating operators needed
RISK_SCORE_THRESHOLD             = 10   # composite risk score above which maintenance alert fires
DEMAND_GROWTH_BASELINE_UTIL      = 70   # % avg util baseline for growth trend calculation
DEMAND_GROWTH_COEFFICIENT        = 0.002  # growth rate per % util above baseline
DEMAND_GROWTH_ALERT_THRESHOLD    = 0.1  # growth trend fraction above which alert fires


# ── Time constants ────────────────────────────────────────────────────────────

MINUTES_PER_DAY  = 24 * 60       # 1440
MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY
MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY


# ── PM schedule intervals (minutes) ──────────────────────────────────────────

PM_INTERVALS = {
    "Monthly":   MINUTES_PER_MONTH,
    "Bi-Weekly": 14 * MINUTES_PER_DAY,
    "Weekly":    MINUTES_PER_WEEK,
}


# ── Time conversion ───────────────────────────────────────────────────────────

def sim_time_to_days(sim_time: float) -> float:
    """Convert simulation time in minutes to days."""
    return round(sim_time / MINUTES_PER_DAY, 2)


def calc_sim_days(sim_time: float) -> float:
    """Alias kept for backward compatibility."""
    return sim_time_to_days(sim_time)


def total_shift_hours(sim_config: dict, shifts_per_day: int, total_days: float) -> float:
    """Total available shift hours for a station over the simulation period."""
    return sim_config.get("SHIFT_DURATION", 480) / 60 * shifts_per_day * total_days


# ── Failure rate ──────────────────────────────────────────────────────────────

def daily_failure_rate_to_per_minute(daily_failure_prob: float) -> float:
    """Convert a daily failure probability to an exponential rate per minute."""
    import math
    clamped = min(0.9999, max(0.0001, daily_failure_prob))
    lambda_daily = -math.log(1 - clamped)
    return lambda_daily / MINUTES_PER_DAY


# ── Per-station utilization ───────────────────────────────────────────────────

def calc_station_utilization(station: dict, sim_config: dict) -> float:
    """
    Station utilization % = busy_time / available_time * 100
    Available time accounts for shift duration, shifts per day, sim days, and capacity.
    """
    busy = station.get("busy_time", 0)
    sim_time = sim_config.get("SIM_TIME", 1)
    capacity = station.get("capacity", 1)
    shifts = station.get("shifts_per_day", 1)
    shift_duration = sim_config.get("SHIFT_DURATION", 480)
    available = shift_duration * shifts * (sim_time / MINUTES_PER_DAY) * capacity
    return round((busy / available * 100) if available > 0 else 0.0, 2)


def calc_operator_utilization(station: dict, sim_config: dict) -> float:
    """
    Operator utilization % = operator_busy_time / available_shift_time * 100
    Denominator is NOT multiplied by operator count — measures work vs available shift time.
    """
    busy = station.get("operator_busy_time", station.get("busy_time", 0))
    sim_time = sim_config.get("SIM_TIME", 1)
    shifts = station.get("shifts_per_day", 1) or 1
    shift_duration = sim_config.get("SHIFT_DURATION", 480)
    available = shift_duration * shifts * (sim_time / MINUTES_PER_DAY)
    return round((busy / available * 100) if available > 0 else 0.0, 2)


def calc_rework_pct(station: dict) -> float:
    """
    Rework Rate (%) = rework_events / completed_jobs * 100
    Industry standard: OEE, Six Sigma, ISO 9001 — unit-count based.
    Answers: what % of jobs needed rework?
    """
    rework_events = station.get("rework_events", 0)
    completed_jobs = station.get("completed_jobs", station.get("completed_jobs_per_station", 0))
    return round(rework_events / completed_jobs * 100, 2) if completed_jobs > 0 else 0.0


def calc_rework_time_ratio(station: dict) -> float:
    """
    Rework Time Ratio (%) = total_rework_time / busy_time * 100
    Capacity metric — what % of working time was spent on rework.
    Separate from rework rate; used for capacity planning and scheduling.
    """
    rework = station.get("total_rework_time", 0)
    busy = station.get("busy_time", 1) or 1
    return round(rework / busy * 100, 2)


def calc_avg_block_time(station: dict) -> float:
    """Average block/wait time per job = total_block_time / job_wait_count"""
    total = station.get("total_block_time", 0)
    count = station.get("job_wait_count", 0)
    return total / count if count > 0 else 0.0


# ── Time allocation percentages ───────────────────────────────────────────────

def calc_time_percentages(
    processing: float, blocked: float, station_dt: float, pause: float,
    op_dt: float, rework: float, mat_unavail: float, waiting: float,
    total_shift_min: float,
) -> Dict[str, float]:
    """All time-as-%-of-total-shift metrics for a station."""
    if total_shift_min <= 0:
        return {k: 0.0 for k in [
            "processing_time_percent", "station_waiting_time_percent",
            "station_downtime_percent", "station_blocked_time_percent",
            "station_pause_time_percent", "operator_downtime_percent",
            "total_rework_time_percent", "material_unavailability_percent",
        ]}
    return {
        "processing_time_percent":         processing    / total_shift_min * 100,
        "station_waiting_time_percent":    waiting       / total_shift_min * 100,
        "station_downtime_percent":        station_dt    / total_shift_min * 100,
        "station_blocked_time_percent":    blocked       / total_shift_min * 100,
        "station_pause_time_percent":      pause         / total_shift_min * 100,
        "operator_downtime_percent":       op_dt         / total_shift_min * 100,
        "total_rework_time_percent":       rework        / total_shift_min * 100,
        "material_unavailability_percent": mat_unavail   / total_shift_min * 100,
    }


# ── Per-station throughput ────────────────────────────────────────────────────

def calc_station_throughput(completed_jobs: int, sim_time: float) -> float:
    """Jobs completed per hour for a single station."""
    if sim_time <= 0:
        return 0.0
    return round((completed_jobs / sim_time) * 60, 4)


# ── Summary KPI formulas ──────────────────────────────────────────────────────

def calc_throughput(completed_jobs: int, sim_time: float) -> float:
    """Overall jobs completed per hour across the whole line."""
    if sim_time <= 0:
        return 0.0
    return round((completed_jobs / sim_time) * 60, 4)


def calc_avg_utilization(utils: List[float]) -> float:
    """Average utilization % across all stations."""
    return round(sum(utils) / len(utils), 2) if utils else 0.0


def calc_peak_utilization(utils: List[float]) -> float:
    """Highest utilization % among all stations."""
    return round(max(utils), 2) if utils else 0.0


def calc_bottleneck_station(station_stats: Dict[str, Any]) -> Optional[str]:
    """Name of the station with the highest utilization."""
    if not station_stats:
        return None
    return max(station_stats, key=lambda n: station_stats[n]["station_utilization"])


def calc_stations_at_risk(utils: List[float]) -> int:
    """Count of stations at or above AT_RISK_UTILIZATION_THRESHOLD."""
    return sum(1 for u in utils if u >= AT_RISK_UTILIZATION_THRESHOLD)


def calc_total_failures(station_stats: Dict[str, Any]) -> int:
    """Total failure breakdowns summed across all stations."""
    return sum(s["failure_breakdowns"] for s in station_stats.values())


def calc_avg_rework_pct(station_stats: Dict[str, Any]) -> float:
    """Average rework percentage across all stations."""
    if not station_stats:
        return 0.0
    return round(sum(s["rework_percentage"] for s in station_stats.values()) / len(station_stats), 2)


# ── AI insights formulas ──────────────────────────────────────────────────────

def calc_maintenance_risk_score(failure_rate: float, utilization: float) -> float:
    """Composite risk score for predictive maintenance alert."""
    return (failure_rate * 100) + (utilization * 0.5)


def calc_demand_growth_trend(avg_utilization: float) -> float:
    """Projected demand growth trend based on average utilization."""
    return max(0.0, (avg_utilization - DEMAND_GROWTH_BASELINE_UTIL) * DEMAND_GROWTH_COEFFICIENT)


def calc_operators_needed(current_operator_util: float, current_operators: int) -> int:
    """Calculate operators needed to bring utilization to target."""
    from math import ceil
    return ceil((current_operator_util / OPERATOR_TARGET_UTILIZATION) * current_operators)


def calc_ai_confidence(stations_data: Dict[str, Any]) -> float:
    """
    Composite AI confidence score (0–0.95).
    Weights: 30% data completeness + 30% util consistency + 20% sample size + 20% model baseline.
    """
    required = ["station_utilization", "operator_utilization", "completed_jobs", "failure_breakdowns"]
    total = len(stations_data) * len(required) if stations_data else 1
    present = sum(1 for s in stations_data.values() for f in required if s.get(f) is not None)
    completeness = present / total if total else 0

    utils = [s.get("station_utilization", 0) for s in stations_data.values()]
    avg_u = sum(utils) / len(utils) if utils else 0
    variance = sum((u - avg_u) ** 2 for u in utils) / len(utils) if utils else 0
    consistency = max(0.0, 1 - variance / 1000)

    sample = min(len(stations_data) / 10, 1.0)
    return min(0.3 * completeness + 0.3 * consistency + 0.2 * sample + 0.2 * 0.8, 0.95)


# ── Bottleneck event impact ───────────────────────────────────────────────────

def calc_breakdown_impact(total_downtime: float, cycle_time: float) -> float:
    """Parts lost due to breakdown downtime."""
    return total_downtime / cycle_time if cycle_time else 0.0


def calc_rework_impact(total_rework_time: float, op_cycle_time: float) -> float:
    """Parts lost due to rework time."""
    return total_rework_time / op_cycle_time if op_cycle_time else 0.0


def calc_wait_time_impact_pct(avg_wait_time: float, effective_cycle: float) -> float:
    """Percentage of cycle time lost to waiting."""
    return (avg_wait_time / effective_cycle) * 100 if effective_cycle else 0.0


def calc_jobs_lost_to_wait(
    busy_time: float, completed_jobs: int, avg_wait_time: float,
    available_minutes: float, capacity: int,
) -> int:
    """Jobs that could not be completed due to wait/block time."""
    if completed_jobs == 0:
        return 0
    avg_process = busy_time / completed_jobs
    effective = avg_process + avg_wait_time or 1
    ideal_jobs = (available_minutes * capacity) / avg_process if avg_process else 0
    actual_cap = (available_minutes * capacity) / effective
    return round(max(0, ideal_jobs - actual_cap))


# ── Convenience: build the full summary dict in one call ─────────────────────

def build_summary(completed_jobs: int, sim_time: float, station_stats: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build the full KPI summary dict from raw simulation outputs.
    Used by both single-run and aggregated-replication paths.
    """
    utils = [s["station_utilization"] for s in station_stats.values()]
    return {
        "throughput":         calc_throughput(completed_jobs, sim_time),
        "avg_utilization":    calc_avg_utilization(utils),
        "peak_utilization":   calc_peak_utilization(utils),
        "bottleneck_station": calc_bottleneck_station(station_stats),
        "stations_at_risk":   calc_stations_at_risk(utils),
        "total_failures":     calc_total_failures(station_stats),
        "avg_rework_pct":     calc_avg_rework_pct(station_stats),
        "sim_days":           calc_sim_days(sim_time),
    }
