"""
SimulationUtils — adapted from UpdatedSimulationProject/models/simulation_utils.py.
All datetime math preserved. Removed Streamlit/Dash dependencies.
"""
import random
import re
from datetime import datetime, timedelta
from typing import Optional, List, Tuple, Any, Dict


class SimulationUtils:

    # ------------------------------------------------------------------
    # Material & rework helpers
    # ------------------------------------------------------------------

    @staticmethod
    def check_material_shortage(stations_data: dict, station_name: str) -> float:
        """Return a random shortage delay (minutes) or 0."""
        prob = stations_data.get(station_name, {}).get("Material Shortage Probability (%)", 0)
        if random.uniform(0, 100) < prob:
            return float(random.randint(30, 60))
        return 0.0

    @staticmethod
    def check_rework(
        stations_data: dict,
        resource_name: str,
        cycle_time: float,
        available_operators: Optional[List[Tuple[str, Any]]],
    ) -> float:
        """Return rework time (minutes) or 0 if no rework needed."""
        if not available_operators:
            return 0.0

        inspector_keywords = ["inspector", "tester", "qa", "vt", "rt"]
        inspectors = [
            op for op in available_operators
            if any(kw in op[0].lower() for kw in inspector_keywords)
        ]
        if not inspectors:
            return 0.0

        rework_prob = stations_data[resource_name].get("Rework Probability (%)", 10)
        if random.uniform(0, 100) < rework_prob:
            return cycle_time * random.uniform(0.2, 0.5)
        return 0.0

    # ------------------------------------------------------------------
    # Shift helpers
    # ------------------------------------------------------------------

    @staticmethod
    def parse_shift_window(value: Any) -> Optional[Tuple[float, float]]:
        """
        Parse a shift time-window string like "08:00-16:00" into
        (start_hour, end_hour) as floats. An end of "00:00" is treated as
        24:00 (midnight = end of day). Returns None for blanks/"nan"/invalid.
        """
        if value is None:
            return None
        s = str(value).strip().lower()
        if not s or s in ("nan", "none", "-", "0"):
            return None
        m = re.match(r"^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$", s)
        if not m:
            return None
        sh, sm, eh, em = (int(g) for g in m.groups())
        start = sh + sm / 60.0
        end = eh + em / 60.0
        if end == 0.0:           # "00:00" end means midnight / end of day
            end = 24.0
        if not (0.0 <= start <= 24.0 and 0.0 < end <= 24.0):
            return None
        return (start, end)

    @staticmethod
    def build_station_shift_config(base_config: dict, station_data: dict) -> dict:
        """
        Return a copy of base_config with SHIFT_n_START / SHIFT_n_END overridden
        by the station's own shift1/shift2/shift3 time-windows where present.

        This lets each station honour its own shift schedule instead of the
        global default. Stations that don't define a given shift window keep the
        global value, so behaviour is unchanged when station windows are absent.
        """
        cfg = dict(base_config)
        for i in (1, 2, 3):
            window = SimulationUtils.parse_shift_window(station_data.get(f"shift{i}"))
            if window:
                cfg[f"SHIFT_{i}_START"], cfg[f"SHIFT_{i}_END"] = window
        return cfg

    @staticmethod
    def is_active_shift(sim_config: dict, real_time: datetime, shifts_per_day: int) -> bool:
        """True if real_time falls within an active shift window."""
        h = real_time.hour + real_time.minute / 60.0

        if shifts_per_day == 0 or shifts_per_day == 3:
            return True  # 24/7

        if shifts_per_day == 1:
            return sim_config["SHIFT_1_START"] <= h < sim_config["SHIFT_1_END"]

        if shifts_per_day == 2:
            return sim_config["SHIFT_1_START"] <= h < sim_config["SHIFT_2_END"]

        return False

    @staticmethod
    def get_active_shift(
        env: Any,
        simulation_state: dict,
        sim_config: dict,
        shifts_per_day: int,
    ) -> Optional[int]:
        """Return active shift number (1-3) or None if outside shift hours."""
        current_dt = simulation_state["start_date"] + timedelta(minutes=env.now)
        h = current_dt.hour + current_dt.minute / 60.0

        if current_dt.weekday() >= 5:
            return None  # Weekend

        def _in(start, end):
            return start <= h < end

        if shifts_per_day >= 1 and _in(sim_config["SHIFT_1_START"], sim_config["SHIFT_1_END"]):
            return 1
        if shifts_per_day >= 2 and _in(sim_config["SHIFT_2_START"], sim_config["SHIFT_2_END"]):
            return 2
        if shifts_per_day >= 3:
            s3, e3 = sim_config["SHIFT_3_START"], sim_config["SHIFT_3_END"]
            if (s3 > e3 and (h >= s3 or h < e3)) or (s3 <= h < e3):
                return 3
        return None

    @staticmethod
    def wait_until_next_shift(
        sim_config: dict,
        real_time: datetime,
        shifts_per_day: int,
    ) -> float:
        """Return minutes to wait until next shift starts."""
        current_mins = real_time.hour * 60 + real_time.minute

        if shifts_per_day == 0:
            return 0.0

        def to_min(h: float) -> int:
            return int(h * 60)

        s1 = to_min(sim_config["SHIFT_1_START"])

        if shifts_per_day == 1:
            e1 = to_min(sim_config["SHIFT_1_END"])
            next_start = s1 + (24 * 60 if current_mins >= e1 else 0)
            return float((next_start - current_mins) % (24 * 60))

        if shifts_per_day == 2:
            e2 = to_min(sim_config["SHIFT_2_END"])
            if current_mins < s1:
                return float(s1 - current_mins)
            if current_mins >= e2:
                return float((24 * 60 - current_mins) + s1)
            return 0.0

        if shifts_per_day == 3:
            s1e = to_min(sim_config["SHIFT_1_END"])
            s2 = to_min(sim_config["SHIFT_2_START"])
            s2e = to_min(sim_config["SHIFT_2_END"])
            s3 = to_min(sim_config["SHIFT_3_START"])
            s3e = to_min(sim_config["SHIFT_3_END"])

            in_shift = (
                (s1 <= current_mins < s1e)
                or (s2 <= current_mins < s2e)
                or (current_mins >= s3)
                or (current_mins < s3e)
            )
            if in_shift:
                return 0.0
            if current_mins < s1:
                return float(s1 - current_mins)
            if current_mins < s2:
                return float(s2 - current_mins)
            return float(s3 - current_mins)

        return 0.0

    @staticmethod
    def calculate_active_shift_time(
        sim_config: dict,
        real_time: datetime,
        shifts_per_day: int,
    ) -> Tuple[float, bool]:
        """
        Return (elapsed_minutes_in_current_shift, is_shift_start).
        Used to determine available time within the current shift window.
        """
        current_mins = real_time.hour * 60 + real_time.minute

        def to_min(h: float) -> int:
            return int(h * 60)

        shifts = [
            (to_min(sim_config["SHIFT_1_START"]), to_min(sim_config["SHIFT_1_END"])),
            (to_min(sim_config["SHIFT_2_START"]), to_min(sim_config["SHIFT_2_END"])),
            (to_min(sim_config["SHIFT_3_START"]), to_min(sim_config["SHIFT_3_END"])),
        ][:shifts_per_day if shifts_per_day != 0 else 3]

        for start, end in shifts:
            if start <= current_mins < end:
                elapsed = current_mins - start
                return float(elapsed), (elapsed == 0)

        return 0.0, False

    # ------------------------------------------------------------------
    # Operator helpers
    # ------------------------------------------------------------------

    @staticmethod
    def get_assigned_operator(stations_data: dict, resource_name: str, current_shift: int) -> Optional[str]:
        station = stations_data.get(resource_name, {})
        return station.get(f"shift{current_shift}", None)

    @staticmethod
    def resolve_assigned_operators(
        stations_data: dict,
        operators_data: dict,
        resource_name: str,
        current_shift: Optional[int],
    ) -> List[str]:
        """
        Return the list of *valid* operator IDs assigned to this station for the
        current shift — i.e. tokens that actually exist in operators_data.

        The Stations sheet's shift1/shift2/shift3 columns are sometimes used to
        hold shift time-windows (e.g. "08:00-16:00") rather than operator IDs.
        Such values are not real operators, so they must NOT gate processing;
        otherwise a job waits forever for an operator that can never exist.
        Returns [] when no valid operator is assigned (→ no operator gating).
        """
        if current_shift is None or not operators_data:
            return []
        raw = SimulationUtils.get_assigned_operator(stations_data, resource_name, current_shift)
        if not raw:
            return []
        tokens = [t.strip() for t in str(raw).split(",")] if isinstance(raw, str) else [raw]
        return [t for t in tokens if t in operators_data]

    @staticmethod
    def operator_available(
        stations_data: dict,
        operators_data: dict,
        resource_name: str,
        current_shift: Optional[int],
    ) -> Optional[List[Tuple[str, Any]]]:
        if current_shift is None:
            return None

        assigned = SimulationUtils.get_assigned_operator(stations_data, resource_name, current_shift)
        if not assigned:
            return None

        if isinstance(assigned, str):
            assigned = [op.strip() for op in assigned.split(",")]

        available = []
        for operator in assigned:
            if operator in operators_data:
                availability = operators_data[operator]["Availability (%)"]
                skill = operators_data[operator]["Skill Rating"]
                if random.uniform(0, 100) <= availability:
                    available.append((operator, skill))

        return available if available else None

    # ------------------------------------------------------------------
    # Process flow helpers
    # ------------------------------------------------------------------

    @staticmethod
    def is_first_station(resource_name: str, processflow_data: dict) -> bool:
        """True if resource_name is the first station in any variant flow."""
        for steps in processflow_data.values():
            if steps and steps[0].get("resource") == resource_name:
                return True
        return False
