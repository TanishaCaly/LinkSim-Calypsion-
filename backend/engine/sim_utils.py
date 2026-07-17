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
    def working_days(sim_config: dict, shift_num: int) -> List[int]:
        """
        Days of the week (Python weekday numbering: Monday=0 ... Sunday=6)
        that the given shift (1, 2, or 3) operates on. Each shift has its
        own independent pattern — WORKING_DAYS_1/2/3 — with no shift
        special-cased to always run every day. Defaults to Mon-Fri for
        shifts 1/2 and every day for shift 3 when unset, matching this
        engine's original hardcoded assumption, so scenarios saved before
        this field existed behave exactly as before.
        """
        key = f"WORKING_DAYS_{shift_num}"
        days = sim_config.get(key)
        if days:
            return list(days)
        return [0, 1, 2, 3, 4] if shift_num in (1, 2) else [0, 1, 2, 3, 4, 5, 6]

    @staticmethod
    def is_active_shift(sim_config: dict, real_time: datetime, shifts_per_day: int) -> bool:
        """True if real_time falls within an active shift window."""
        h = real_time.hour + real_time.minute / 60.0

        if shifts_per_day == 0:
            return True  # 24/7, no weekly schedule at all

        weekday = real_time.weekday()

        if shifts_per_day == 1:
            return (
                weekday in SimulationUtils.working_days(sim_config, 1)
                and sim_config["SHIFT_1_START"] <= h < sim_config["SHIFT_1_END"]
            )

        if shifts_per_day == 2:
            return (
                weekday in SimulationUtils.working_days(sim_config, 2)
                and sim_config["SHIFT_1_START"] <= h < sim_config["SHIFT_2_END"]
            )

        if shifts_per_day == 3:
            s1, e1 = sim_config["SHIFT_1_START"], sim_config["SHIFT_1_END"]
            s2, e2 = sim_config["SHIFT_2_START"], sim_config["SHIFT_2_END"]
            s3, e3 = sim_config["SHIFT_3_START"], sim_config["SHIFT_3_END"]
            if weekday in SimulationUtils.working_days(sim_config, 1) and s1 <= h < e1:
                return True
            if weekday in SimulationUtils.working_days(sim_config, 2) and s2 <= h < e2:
                return True
            if weekday in SimulationUtils.working_days(sim_config, 3):
                return (s3 > e3 and (h >= s3 or h < e3)) or (s3 <= h < e3)
            return False

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
        weekday = current_dt.weekday()

        def _in(start, end):
            return start <= h < end

        if (
            shifts_per_day >= 1
            and weekday in SimulationUtils.working_days(sim_config, 1)
            and _in(sim_config["SHIFT_1_START"], sim_config["SHIFT_1_END"])
        ):
            return 1
        if (
            shifts_per_day >= 2
            and weekday in SimulationUtils.working_days(sim_config, 2)
            and _in(sim_config["SHIFT_2_START"], sim_config["SHIFT_2_END"])
        ):
            return 2
        if shifts_per_day >= 3 and weekday in SimulationUtils.working_days(sim_config, 3):
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

        def skip_to_working_day(wait: float, shift_num: int) -> float:
            # If the computed wait lands on a day this shift doesn't
            # operate on, keep rolling forward a day at a time (to the same
            # shift-start time-of-day) until it lands on one that does.
            # Handles arbitrary day patterns, not just a contiguous block.
            days = SimulationUtils.working_days(sim_config, shift_num)
            landing_day = real_time + timedelta(minutes=wait)
            extra_days = 0
            while (landing_day + timedelta(days=extra_days)).weekday() not in days:
                extra_days += 1
                if extra_days > 7:
                    break  # no working days configured at all — give up rather than loop forever
            return wait + extra_days * 24 * 60

        s1 = to_min(sim_config["SHIFT_1_START"])

        if shifts_per_day == 1:
            e1 = to_min(sim_config["SHIFT_1_END"])
            next_start = s1 + (24 * 60 if current_mins >= e1 else 0)
            wait = float((next_start - current_mins) % (24 * 60))
            return skip_to_working_day(wait, 1)

        if shifts_per_day == 2:
            e2 = to_min(sim_config["SHIFT_2_END"])
            if current_mins < s1:
                return skip_to_working_day(float(s1 - current_mins), 2)
            if current_mins >= e2:
                return skip_to_working_day(float((24 * 60 - current_mins) + s1), 2)
            # Time-of-day is within the shift window, but is_active_shift only
            # calls us when it already said "not active" — that only happens
            # here on a non-working day, so roll forward instead of a 0-wait.
            return skip_to_working_day(0.0, 2)

        if shifts_per_day == 3:
            s1e = to_min(sim_config["SHIFT_1_END"])
            s2 = to_min(sim_config["SHIFT_2_START"])
            s2e = to_min(sim_config["SHIFT_2_END"])
            s3 = to_min(sim_config["SHIFT_3_START"])
            s3e = to_min(sim_config["SHIFT_3_END"])

            weekday = real_time.weekday()
            in_shift1 = weekday in SimulationUtils.working_days(sim_config, 1) and s1 <= current_mins < s1e
            in_shift2 = weekday in SimulationUtils.working_days(sim_config, 2) and s2 <= current_mins < s2e
            in_shift3 = weekday in SimulationUtils.working_days(sim_config, 3) and (
                current_mins >= s3 or current_mins < s3e
            )
            if in_shift1 or in_shift2 or in_shift3:
                return 0.0

            # Not currently in any shift — find the soonest upcoming shift
            # start, rolling each candidate forward to a day that shift
            # actually operates on, then take the minimum wait.
            candidates = []
            if current_mins < s1:
                candidates.append(skip_to_working_day(float(s1 - current_mins), 1))
            else:
                candidates.append(skip_to_working_day(float(s1 - current_mins) % (24 * 60), 1))
            if current_mins < s2:
                candidates.append(skip_to_working_day(float(s2 - current_mins), 2))
            else:
                candidates.append(skip_to_working_day(float(s2 - current_mins) % (24 * 60), 2))
            if current_mins < s3:
                candidates.append(skip_to_working_day(float(s3 - current_mins), 3))
            else:
                candidates.append(skip_to_working_day(float(s3 - current_mins) % (24 * 60), 3))
            return min(candidates)

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
            if not steps:
                continue
            first = steps[0].get("resource")
            if first == resource_name:
                return True
            # Routing step ("Exit controller type") — resource is a dict of
            # possible destinations rather than a single name; treat it as a
            # first station if resource_name is one of its options.
            if isinstance(first, dict) and resource_name in first.get("options", []):
                return True
        return False
