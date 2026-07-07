"""
Bottleneck analysis — adapted from UpdatedSimulationProject/models/Bottleneck_analysis.py.
Removed Dash/Streamlit deps. Improved: no random in event_analyse (was placeholder).
"""
import re
import random
from math import ceil
from typing import Dict, List, Any, Optional

from .formulas import (
    calc_station_utilization, calc_operator_utilization, total_shift_hours,
    sim_time_to_days, BOTTLENECK_UTILIZATION_THRESHOLD,
    calc_breakdown_impact, calc_rework_impact, calc_wait_time_impact_pct,
    calc_jobs_lost_to_wait, calc_operators_needed,
)


def _station_utilization(station: dict, sim_config: dict) -> float:
    return calc_station_utilization(station, sim_config)


def _operator_utilization(station: dict, sim_config: dict) -> float:
    return calc_operator_utilization(station, sim_config)


def _total_shift_hours(sim_config: dict, shifts_per_day: int, total_days: float) -> float:
    return total_shift_hours(sim_config, shifts_per_day, total_days)


# ---------------------------------------------------------------------------
# Main bottleneck identification
# ---------------------------------------------------------------------------

def identify_bottlenecks(
    station_name: str,
    station_info: dict,
    operators_data: dict,
    sim_config: dict,
    cycle_times: dict,
) -> List[Dict[str, Any]]:
    """
    Return up to 3 prioritised bottleneck records for a station,
    each with type / metric / recommendation / estimated_gain / difficulty.
    """
    bottlenecks: List[Dict] = []

    total_simulated_time = station_info.get("total_simulated_time_per_station", 1)
    shifts_per_day = station_info.get("shifts_per_day", 1)
    total_days = sim_time_to_days(total_simulated_time)

    current_station_util = _station_utilization(station_info, sim_config)
    current_operator_util = _operator_utilization(station_info, sim_config)
    avg_block_time = station_info.get("avg_block_time", 0)
    failure_rate = station_info.get("Failure rate", 0)
    pm_schedule = station_info.get("PM Schedule", "Monthly")

    cycle_time = _skill_adjusted_cycle_time(station_info, operators_data, cycle_times, station_name)
    station_info["adjusted_cycle_time"] = cycle_time

    assigned_operators = _get_assigned_operators(station_info)
    avg_skill = _avg_skill(assigned_operators, operators_data)
    avg_availability = _avg_availability(assigned_operators, operators_data)

    if avg_block_time <= 240:
        return []  # Not a significant bottleneck

    # --- Failure rate ---
    if failure_rate > 0.01:
        current_pm_interval = {"Monthly": 30, "Bi-Weekly": 14, "Weekly": 7}.get(pm_schedule, 30)
        recommended_pm = "Bi-Weekly" if current_pm_interval > 14 else "Weekly"
        failure_reduction = min(failure_rate * 0.7, 0.005)
        downtime_reduction = (
            (failure_rate - failure_reduction)
            * station_info.get("Repair Time", 0)
            * station_info.get("completed_jobs_per_station", 0)
            * total_days
        )
        gain = round(downtime_reduction / cycle_time) if cycle_time else 0
        bottlenecks.append({
            "type": "failure_rate",
            "metric": f"{failure_rate * 100:.1f}% failure rate",
            "recommendation": (
                f"Improve PM from {pm_schedule} to {recommended_pm} "
                f"(failure rate: {failure_rate*100:.1f}% → {failure_reduction*100:.1f}%)"
            ),
            "estimated_gain": f"+{gain} parts",
            "current_util": f"{current_station_util:.1f}%",
            "difficulty": "Medium",
        })

    # --- Operator skill ---
    if avg_skill < 2 and cycle_time > 60:
        skill_boost = min(5 - avg_skill, 1.5)
        new_cycle = cycle_time * (1 - skill_boost * 0.1)
        reduction = cycle_time - new_cycle
        gain = round(station_info.get("completed_jobs_per_station", 0) * reduction / cycle_time)
        bottlenecks.append({
            "type": "operator_skill",
            "metric": f"Avg skill: {avg_skill:.1f}, cycle: {cycle_time:.1f}m",
            "recommendation": (
                f"Training programme: raise avg skill {avg_skill:.1f} → {avg_skill + skill_boost:.1f}"
            ),
            "estimated_gain": f"+{gain} parts ({reduction:.1f}m cycle reduction/part)",
            "current_util": f"{current_station_util:.1f}%",
            "difficulty": "Medium",
        })

    # --- Operator availability ---
    if avg_availability < 100:
        target_avail = min(avg_availability + 1, 100)
        if target_avail > avg_availability:
            improvement = (target_avail - avg_availability) / 100
            additional_time = (
                improvement
                * station_info.get("operator_per_station", 1)
                * sim_config.get("SHIFT_DURATION", 480)
                * shifts_per_day
                * total_days
            )
            gain = round(additional_time / cycle_time) if cycle_time else 0
            bottlenecks.append({
                "type": "operator_availability",
                "metric": f"{avg_availability:.0f}% availability",
                "recommendation": (
                    f"Improve availability to {target_avail:.0f}% via better scheduling"
                ),
                "estimated_gain": f"+{gain} parts",
                "current_util": f"{current_station_util:.1f}%",
                "difficulty": "Low",
            })

    # --- Station capacity ---
    if current_station_util >= BOTTLENECK_UTILIZATION_THRESHOLD:
        current_cap = station_info.get("capacity", 1)
        boost = 2 if (current_station_util > 95 or avg_block_time > 240) else 1
        max_per_shift = (sim_config.get("SHIFT_DURATION", 480)) / cycle_time if cycle_time else 1
        max_feasible = ceil(max_per_shift * shifts_per_day)
        new_cap = min(current_cap + boost, max_feasible)

        if new_cap > current_cap:
            wait_reduction = avg_block_time * (1 - current_cap / new_cap)
            daily_gain = (
                (new_cap - current_cap)
                * (sim_config.get("SHIFT_DURATION", 480) / cycle_time if cycle_time else 0)
                * shifts_per_day
            )
            total_gain = int(daily_gain * total_days)
            bottlenecks.append({
                "type": "station_capacity",
                "metric": f"{avg_block_time:.1f}m wait | {current_station_util:.1f}% util",
                "recommendation": (
                    f"Increase capacity {current_cap} → {new_cap} "
                    f"(wait: {avg_block_time:.1f}m → {avg_block_time - wait_reduction:.1f}m)"
                ),
                "estimated_gain": f"+{total_gain} parts",
                "current_util": f"{current_station_util:.1f}%",
                "difficulty": "High",
            })

    # --- Operator count ---
    if current_operator_util > BOTTLENECK_UTILIZATION_THRESHOLD:
        ops_needed = calc_operators_needed(current_operator_util, station_info.get("operator_per_station", 1))
        ops_boost = max(1, ops_needed - station_info.get("operator_per_station", 1))
        util_reduction = current_operator_util * (
            1 - station_info.get("operator_per_station", 1) / ops_needed
        ) if ops_needed else 0
        bottlenecks.append({
            "type": "operator_count",
            "metric": f"{current_operator_util:.1f}% operator util | {avg_block_time:.1f}m wait",
            "recommendation": (
                f"Add {ops_boost} operator(s): "
                f"{station_info.get('operator_per_station', 1)} → {ops_needed}"
            ),
            "estimated_gain": (
                f"Util reduction: {current_operator_util:.1f}% → "
                f"{current_operator_util - util_reduction:.1f}%"
            ),
            "current_util": f"{current_operator_util:.1f}%",
            "difficulty": "Low" if ops_boost <= 2 else "Medium",
        })

    priority_order = ["failure_rate", "operator_availability", "operator_skill",
                      "operator_count", "station_capacity"]
    bottlenecks.sort(key=lambda b: (
        -_extract_gain(b),
        priority_order.index(b["type"]) if b["type"] in priority_order else 99,
    ))
    return bottlenecks[:3]


def calculate_affected_jobs(
    station_name: str,
    station_info: dict,
    sim_config: dict,
    cycle_times: dict,
) -> Dict[str, Any]:
    shifts_per_day = station_info.get("shifts_per_day", 1)
    total_days = sim_config.get("total_days", 1)
    completed_jobs = station_info.get("completed_jobs", 0)
    busy_time = station_info.get("busy_time", 0)
    avg_wait_time = station_info.get("avg_wait_time", 0)

    if completed_jobs == 0:
        return {
            "station": station_name,
            "jobs_affected": 0,
            "wait_time_impact": "0%",
            "utilization": _station_utilization(station_info, sim_config),
        }

    available = _total_shift_hours(sim_config, shifts_per_day, total_days) * 60
    cap = station_info.get("capacity", 1)
    avg_process = busy_time / completed_jobs
    effective = avg_process + avg_wait_time or 1

    return {
        "station": station_name,
        "jobs_affected": calc_jobs_lost_to_wait(busy_time, completed_jobs, avg_wait_time, available, cap),
        "wait_time_impact": f"{calc_wait_time_impact_pct(avg_wait_time, effective):.1f}%",
        "utilization": _station_utilization(station_info, sim_config),
    }


def event_analyse(station_name: str, station_info: dict, cycle_times: dict) -> List[Dict]:
    """
    Event-centric report: Breakdowns / Rework / Operator Absence.
    Removed random.uniform placeholder — uses actual stored values.
    """
    cycle_time = cycle_times.get(station_name, 1) or 1
    ops = station_info.get("operator_per_station", 1) or 1
    op_cycle = cycle_time / ops

    analysis = {
        "Breakdowns": {
            "frequency": station_info.get("failure_breakdowns", 0) + station_info.get("pm_breakdowns", 0),
            "impact": calc_breakdown_impact(station_info.get("total_station_downtime", 0), cycle_time),
        },
        "Rework": {
            "frequency": station_info.get("rework_events", 0),
            "impact": calc_rework_impact(station_info.get("total_rework_time", 0), op_cycle),
        },
        "Operator Absence": {
            "frequency": station_info.get("operator_downtime_events", 0),
            "impact": calc_rework_impact(station_info.get("total_operator_downtime", 0), op_cycle),
        },
    }

    return [
        {
            "station": station_name,
            "Event Type": event_type,
            "Frequency": data["frequency"],
            "Impact (Parts)": f"-{round(data['impact'])} parts",
        }
        for event_type, data in analysis.items()
    ]


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _extract_gain(b: dict) -> int:
    match = re.search(r"([+-]?\d+)", b.get("estimated_gain", ""))
    return int(match.group(1)) if match else 0


def _get_assigned_operators(station_info: dict) -> List[str]:
    operators = []
    for shift in ["shift1", "shift2", "shift3"]:
        val = station_info.get(shift)
        if val:
            operators.extend([op.strip() for op in val.split(",")])
    return list(set(operators))


def _avg_skill(operators: List[str], operators_data: dict) -> float:
    valid = [op for op in operators if op in operators_data]
    return sum(operators_data[op]["Skill Rating"] for op in valid) / len(valid) if valid else 0.0


def _avg_availability(operators: List[str], operators_data: dict) -> float:
    valid = [op for op in operators if op in operators_data]
    return sum(operators_data[op]["Availability (%)"] for op in valid) / len(valid) if valid else 0.0


def _skill_adjusted_cycle_time(
    station_info: dict,
    operators_data: dict,
    cycle_times: dict,
    station_name: str,
) -> float:
    base = cycle_times.get(station_name, 0)
    operators = _get_assigned_operators(station_info)
    avg_skill = _avg_skill(operators, operators_data)
    return base * (1 - (avg_skill - 1) * 0.05)
