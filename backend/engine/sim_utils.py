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
    def num_shifts(sim_config: dict) -> int:
        """
        How many shifts/day this scenario defines. Derived from the highest
        SHIFT_n_START key actually present in sim_config, so the shift count
        is however many the scenario was configured with — not a fixed 3.
        Falls back to 3 (the engine's original fixed count) when none of
        SHIFT_1_START.. are set, so scenarios saved before this was
        generalized behave exactly as before.
        """
        n = 0
        i = 1
        while f"SHIFT_{i}_START" in sim_config:
            n = i
            i += 1
        return n or 3

    @staticmethod
    def build_station_shift_config(base_config: dict, station_data: dict) -> dict:
        """
        Return a copy of base_config with SHIFT_n_START/SHIFT_n_END,
        WORKING_DAYS_n, and BREAKS_n overridden by the station's own
        per-shift settings where present (any number of shifts, not just 1-3).

        This lets each station honour its own shift hours, weekly working-days
        calendar, AND break windows instead of the global default — e.g. one
        station running Shift 1 6am-2pm with no break while another runs
        Shift 1 8am-4pm with a lunch break, despite both using "Shift 1".
        Stations that don't define a given override keep the global value, so
        behaviour is unchanged for every station that doesn't set one (every
        Excel/YAML-imported scenario, and any station saved before these
        fields existed).

        The returned dict is genuinely PER-STATION — sim_core.py builds one
        of these per station name at init and uses it (not the global
        sim_config) everywhere a shift-active/working-day/break check
        happens, so this override reaches every one of those checks
        automatically.
        """
        cfg = dict(base_config)
        for i in range(1, SimulationUtils.num_shifts(base_config) + 1):
            window = SimulationUtils.parse_shift_window(station_data.get(f"shift{i}"))
            if window:
                cfg[f"SHIFT_{i}_START"], cfg[f"SHIFT_{i}_END"] = window
            working_days = station_data.get(f"workingDays{i}")
            if working_days:
                cfg[f"WORKING_DAYS_{i}"] = list(working_days)
            station_breaks = station_data.get(f"breaks{i}")
            if station_breaks is not None:
                cfg[f"BREAKS_{i}"] = list(station_breaks)
        return cfg

    @staticmethod
    def active_shift_set(shifts_per_day: Any, num_shifts: int = 3) -> set:
        """
        Normalize a station's configured shift availability into a set of
        active shift numbers (1..num_shifts).

        Accepts either the legacy count form (an int/float N meaning "shifts
        1..N", e.g. 2 -> {1, 2}) or an explicit list/tuple/set of shift
        numbers (e.g. [2, 3] -> {2, 3}, allowing gaps like shift 1 skipped).
        0 or an empty list means 24/7 (no weekly schedule at all) — callers
        check for that separately since it isn't really "a set of shifts".
        """
        if isinstance(shifts_per_day, (list, tuple, set, frozenset)):
            return {int(n) for n in shifts_per_day if 1 <= int(n) <= num_shifts}
        n = int(shifts_per_day)
        return set(range(1, n + 1)) if n > 0 else set()

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
    def breaks(sim_config: dict, shift_num: int) -> List[Tuple[float, float]]:
        """
        List of (start_hour, end_hour) break windows configured for the
        given shift (1, 2, or 3) — e.g. a lunch break. A shift can have any
        number of breaks. Defaults to none when BREAKS_n isn't set, so
        scenarios saved before this field existed behave exactly as before.
        """
        raw = sim_config.get(f"BREAKS_{shift_num}")
        if not raw:
            return []
        return [(float(b["start"]), float(b["start"]) + float(b["duration"]) / 60.0) for b in raw]

    @staticmethod
    def _in_break(h: float, break_windows: List[Tuple[float, float]]) -> bool:
        """True if hour-of-day h falls inside any of the given break windows."""
        return any(bs <= h < be for bs, be in break_windows)

    @staticmethod
    def minutes_until_next_break(sim_config: dict, real_time: datetime, shifts_per_day: Any) -> float:
        """
        Minutes from real_time until the next break starts, for whichever
        shift(s) are relevant given shifts_per_day — or float('inf') if none
        is coming up. Lets the main processing loop cap how long a single
        uninterrupted processing chunk can run for, so a break shorter than
        one job's remaining cycle time still actually pauses that job,
        instead of the whole chunk silently running through it in one
        env.timeout() with no intermediate is_active_shift check.
        """
        shift_nums = SimulationUtils.active_shift_set(shifts_per_day, SimulationUtils.num_shifts(sim_config))
        if not shift_nums:
            return float("inf")
        h = real_time.hour + real_time.minute / 60.0
        soonest = float("inf")
        for shift_num in shift_nums:
            for bs, _be in SimulationUtils.breaks(sim_config, shift_num):
                if bs >= h:
                    soonest = min(soonest, (bs - h) * 60.0)
        return soonest

    @staticmethod
    def _shift_window_active(sim_config: dict, shift_num: int, h: float, weekday: int) -> bool:
        """True if hour-of-day h on the given weekday falls inside shift_num's
        window (handling an overnight window like Shift 3's 22:00-06:00) and
        working-day pattern, and isn't currently on a break for that shift."""
        s = sim_config[f"SHIFT_{shift_num}_START"]
        e = sim_config[f"SHIFT_{shift_num}_END"]
        if weekday not in SimulationUtils.working_days(sim_config, shift_num):
            return False
        in_window = (s > e and (h >= s or h < e)) or (s <= h < e)
        if not in_window:
            return False
        return not SimulationUtils._in_break(h, SimulationUtils.breaks(sim_config, shift_num))

    @staticmethod
    def is_active_shift(sim_config: dict, real_time: datetime, shifts_per_day: Any) -> bool:
        """True if real_time falls within one of the station's active shifts
        (and not on a break for that shift)."""
        shift_nums = SimulationUtils.active_shift_set(shifts_per_day, SimulationUtils.num_shifts(sim_config))
        if not shift_nums:
            return True  # 24/7, no weekly schedule at all

        h = real_time.hour + real_time.minute / 60.0
        weekday = real_time.weekday()
        return any(
            SimulationUtils._shift_window_active(sim_config, shift_num, h, weekday)
            for shift_num in shift_nums
        )

    @staticmethod
    def get_active_shift(
        env: Any,
        simulation_state: dict,
        sim_config: dict,
        shifts_per_day: Any,
    ) -> Optional[int]:
        """Return active shift number (1-3) or None if outside shift hours."""
        current_dt = simulation_state["start_date"] + timedelta(minutes=env.now)
        h = current_dt.hour + current_dt.minute / 60.0
        weekday = current_dt.weekday()

        shift_nums = SimulationUtils.active_shift_set(shifts_per_day, SimulationUtils.num_shifts(sim_config))
        for shift_num in sorted(shift_nums):
            if SimulationUtils._shift_window_active(sim_config, shift_num, h, weekday):
                return shift_num
        return None

    @staticmethod
    def wait_until_next_shift(
        sim_config: dict,
        real_time: datetime,
        shifts_per_day: Any,
    ) -> float:
        """Return minutes to wait until next shift starts."""
        current_mins = real_time.hour * 60 + real_time.minute

        shift_nums = SimulationUtils.active_shift_set(shifts_per_day, SimulationUtils.num_shifts(sim_config))
        if not shift_nums:
            return 0.0

        def to_min(h: float) -> int:
            return int(h * 60)

        h = real_time.hour + real_time.minute / 60.0
        weekday0 = real_time.weekday()

        # If the reason is_active_shift said "not active" is that we're
        # currently on a break (not off-shift entirely), the wait is just
        # until that break ends — much shorter than rolling to the next
        # shift/working day, and shouldn't fall through to that logic.
        for shift_num in sorted(shift_nums):
            s, e = sim_config[f"SHIFT_{shift_num}_START"], sim_config[f"SHIFT_{shift_num}_END"]
            in_window = (s > e and (h >= s or h < e)) or (s <= h < e)
            if not in_window or weekday0 not in SimulationUtils.working_days(sim_config, shift_num):
                continue
            for bs, be in SimulationUtils.breaks(sim_config, shift_num):
                if bs <= h < be:
                    return float(to_min(be) - to_min(h))

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

        # If currently inside any active shift's window (just on a
        # non-working day, since a break was already handled above), roll
        # forward a day at a time on that same shift rather than waiting a
        # full 24h — matches each shift's own working-day pattern.
        for shift_num in sorted(shift_nums):
            s, e = sim_config[f"SHIFT_{shift_num}_START"], sim_config[f"SHIFT_{shift_num}_END"]
            in_window = (s > e and (h >= s or h < e)) or (s <= h < e)
            if in_window:
                return skip_to_working_day(0.0, shift_num)

        # Not currently in any shift window — find the soonest upcoming
        # shift start among the station's active shifts, rolling each
        # candidate forward to a day that shift actually operates on.
        candidates = []
        for shift_num in shift_nums:
            s = to_min(sim_config[f"SHIFT_{shift_num}_START"])
            wait = float(s - current_mins) if current_mins < s else float(s - current_mins) % (24 * 60)
            candidates.append(skip_to_working_day(wait, shift_num))
        return min(candidates)

    @staticmethod
    def calculate_active_shift_time(
        sim_config: dict,
        real_time: datetime,
        shifts_per_day: Any,
    ) -> Tuple[float, bool]:
        """
        Return (elapsed_minutes_in_current_shift, is_shift_start).
        Used to determine available time within the current shift window.
        """
        current_mins = real_time.hour * 60 + real_time.minute

        def to_min(h: float) -> int:
            return int(h * 60)

        n = SimulationUtils.num_shifts(sim_config)
        shift_nums = SimulationUtils.active_shift_set(shifts_per_day, n) or set(range(1, n + 1))

        for shift_num in sorted(shift_nums):
            start = to_min(sim_config[f"SHIFT_{shift_num}_START"])
            end = to_min(sim_config[f"SHIFT_{shift_num}_END"])
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
