"""
CSV parser -- adapted from UpdatedSimulationProject/parsers/csv_parser.py.
Removed Dash base64 encoding. Accepts file paths OR raw string content.
"""
import io
import math
import re
import pandas as pd
from typing import Dict, List, Any, Union, Optional


def _clean_str(value: Any, default: str = "") -> str:
    """Stringify a cell value, treating pandas NaN/None (common in blank
    trailing rows from Excel) as empty rather than the literal text 'nan'."""
    if value is None:
        return default
    if isinstance(value, float) and math.isnan(value):
        return default
    text = str(value).strip()
    return text if text.lower() != "nan" else default


def _safe_int(value: Any, default: int = 0) -> int:
    """int() that treats NaN/None/blank as the default instead of crashing —
    Excel sheets routinely have blank cells or trailing empty rows."""
    if value is None:
        return default
    if isinstance(value, float) and math.isnan(value):
        return default
    if isinstance(value, str) and not value.strip():
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    """float() that treats NaN/None/blank as the default instead of crashing."""
    if value is None:
        return default
    if isinstance(value, float) and math.isnan(value):
        return default
    if isinstance(value, str) and not value.strip():
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_col(name: str) -> str:
    """Lowercase and collapse spaces/hyphens/underscores so 'Setup-time',
    'Setup_time', and 'Setup Time' all compare equal."""
    return re.sub(r"[\s_-]+", " ", name.strip().lower())


def _find_col(row: Dict[str, Any], *candidates: str) -> Any:
    """
    Look up a value in a row dict by trying each candidate key, first as an
    exact match, then as a case-insensitive substring match against the
    row's actual column names (spaces/hyphens/underscores treated as
    equivalent). This lets slightly-renamed headers still map correctly —
    e.g. a column literally named "Capacity (machines)", "Repair Time (min)",
    or "Setup-Time" should still be found when we ask for "capacity" or
    "setup time", instead of silently falling back to the default value.
    """
    # Exact match first (fast path, preserves existing behaviour)
    for cand in candidates:
        if cand in row:
            return row[cand]
    # Fuzzy: row column contains the candidate as a substring, ignoring
    # case and treating spaces/hyphens/underscores as interchangeable
    norm_keys = {_normalize_col(str(k)): k for k in row.keys()}
    for cand in candidates:
        cand_norm = _normalize_col(cand)
        for nk, original_key in norm_keys.items():
            if cand_norm and cand_norm in nk:
                return row[original_key]
    return None


def _is_blank_row(row: Dict[str, Any]) -> bool:
    """True if every value in the row is blank/NaN/None — used to detect a
    trailing spacer row that should end data parsing (so stray notes below
    it, like a footnote sentence, never get mistaken for a data row)."""
    return all(not _clean_str(v) for v in row.values())


class CsvParser:
    """
    Parse CSV files into the structured dicts expected by ManufacturingSimulation.

    Supports three input modes:
      - file path  (str ending with .csv, short path)
      - bytes      (raw file bytes from an HTTP upload)
      - str        (raw CSV text)
    """

    def parse(self, source: Union[str, bytes, io.IOBase]) -> List[Dict[str, Any]]:
        """Return list of dicts from a CSV source."""
        try:
            if isinstance(source, bytes):
                df = pd.read_csv(io.BytesIO(source))
            elif isinstance(source, str):
                # If string has a newline or is longer than any reasonable path,
                # treat it as inline CSV text rather than a file path.
                if "\n" in source or len(source) > 512:
                    df = pd.read_csv(io.StringIO(source))
                else:
                    df = pd.read_csv(source)
            else:
                df = pd.read_csv(source)

            return df.to_dict("records")
        except Exception as exc:
            raise ValueError(f"CSV parse error: {exc}") from exc

    # ------------------------------------------------------------------
    # Structured loaders -- produce the exact dicts sim_core.py expects
    # ------------------------------------------------------------------

    def parse_stations(self, source: Union[str, bytes]) -> Dict[str, Dict]:
        """
        Expected columns: Station, Capacity, shifts_per_day, operator_per_station,
        Failure rate, Repair Time, Setup time, PM Schedule, Material Shortage
        Probability (%), Rework Probability (%), shift1, shift2, shift3, STATION_DOWNTIME

        Column names are matched loosely (case-insensitive substring), so
        slight variations like "Capacity (machines)" or "Repair Time (min)"
        still map to the right field instead of silently falling back to
        a default value.
        """
        records = self.parse(source)
        stations = {}
        for row in records:
            if _is_blank_row(row):
                break  # a fully-blank row marks the end of real data; anything
                       # after it (e.g. a footnote sentence) is not a station
            name = _clean_str(_find_col(row, "Station", "station"))
            if not name:
                continue  # skip blank/trailing rows
            stations[name] = {
                "capacity": _safe_int(_find_col(row, "Capacity", "capacity"), 1),
                "shifts_per_day": _safe_int(_find_col(row, "shifts_per_day", "shifts/day", "shifts per day"), 1),
                "operator_per_station": _safe_int(_find_col(row, "operator_per_station", "operators"), 1),
                "Failure rate": _safe_float(_find_col(row, "Failure rate", "failure_rate"), 0),
                "Repair Time": _safe_float(_find_col(row, "Repair Time", "repair_time"), 10),
                "Setup time": _safe_float(_find_col(row, "Setup time", "setup_time"), 0),
                "Buffer Capacity": _safe_int(_find_col(row, "Buffer Capacity", "buffer_capacity"), 0),
                "Buffer Discipline": _clean_str(_find_col(row, "Buffer Discipline", "buffer_discipline"), "FIFO"),
                "Buffer Width": _safe_int(_find_col(row, "Buffer Width", "buffer_width"), 0),
                "Buffer Depth": _safe_int(_find_col(row, "Buffer Depth", "buffer_depth"), 0),
                "Buffer Height": _safe_int(_find_col(row, "Buffer Height", "buffer_height"), 0),
                "PM Schedule": _clean_str(_find_col(row, "PM Schedule", "pm_schedule"), "Monthly"),
                "Material Shortage Probability (%)": _safe_float(
                    _find_col(row, "Material Shortage Probability (%)", "material shortage"), 0),
                "Rework Probability (%)": _safe_float(_find_col(row, "Rework Probability (%)", "rework"), 10),
                "shift1": _clean_str(_find_col(row, "shift1", "shift 1")),
                "shift2": _clean_str(_find_col(row, "shift2", "shift 2")),
                "shift3": _clean_str(_find_col(row, "shift3", "shift 3")),
                "STATION_DOWNTIME": _safe_float(_find_col(row, "STATION_DOWNTIME", "station_downtime"), 0),
            }
        return stations

    def parse_operators(self, source: Union[str, bytes]) -> Dict[str, Dict]:
        """Expected columns: Operator, Skill Rating, Availability (%)"""
        records = self.parse(source)
        operators = {}
        for row in records:
            name = _clean_str(row.get("Operator", row.get("operator")))
            if not name:
                continue  # skip blank/trailing rows
            operators[name] = {
                "Skill Rating": _safe_float(row.get("Skill Rating", row.get("skill_rating")), 1),
                "Availability (%)": _safe_float(row.get("Availability (%)", row.get("availability_pct")), 100),
            }
        return operators

    def parse_processflow(self, source: Union[str, bytes]) -> Dict[str, List[Dict]]:
        """
        Expected columns: Variant, Operation, Resource, Duration
        Optional columns: Rule, Condition/Weight — express a branching step
        ("Exit controller type") without any JSON/code in a cell: add a
        SECOND row for the same (Variant, Operation) naming an alternate
        Resource, with Rule set to one of round_robin/percentage/
        condition/shortest_queue and Condition/Weight holding the
        mode-specific value (a weight number, or a literal value to match
        for "condition"). A (Variant, Operation) that appears only once
        keeps today's plain-string resource — nothing changes unless a
        company's sheet intentionally adds a branching row.

        Returns: {variant: [{operation, resource, duration}, ...]}
        (resource is a plain string for a single-destination step, or a
        routing dict {mode, options, weights?, rules?, default?} for a
        branching step — see backend/engine/sim_core.py's
        _resolve_step_resource for how the engine consumes this shape.)
        Variant names are normalised to lowercase for consistent matching.
        """
        records = self.parse(source)
        # Group rows by (variant, operation), preserving first-seen order —
        # a variant's steps must stay in the sequence they appear in the sheet.
        groups: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
        order: Dict[str, List[str]] = {}
        for row in records:
            variant = _clean_str(row.get("Variant", row.get("variant"))).lower()
            if not variant:
                continue  # skip blank/trailing rows
            operation = _clean_str(row.get("Operation", row.get("operation")))
            resource = _clean_str(row.get("Resource", row.get("resource")))
            duration = _safe_float(row.get("Duration", row.get("duration")), 0)
            rule = _clean_str(_find_col(row, "Rule", "rule")).strip().lower()
            weight_raw = _find_col(row, "Condition/Weight", "condition_weight", "weight", "condition")

            groups.setdefault(variant, {})
            order.setdefault(variant, [])
            key = operation
            if key not in groups[variant]:
                groups[variant][key] = []
                order[variant].append(key)
            groups[variant][key].append({
                "resource": resource, "duration": duration, "rule": rule, "weight_raw": weight_raw,
            })

        flow: Dict[str, List[Dict]] = {}
        for variant, op_order in order.items():
            steps: List[Dict[str, Any]] = []
            for operation in op_order:
                rows = groups[variant][operation]
                duration = rows[0]["duration"]
                if len(rows) == 1 and not rows[0]["rule"]:
                    # Single destination — unchanged, today's plain-string behaviour.
                    steps.append({"operation": operation, "resource": rows[0]["resource"], "duration": duration})
                    continue

                # Branching step: merge the group's rows into one routing dict.
                mode = next((r["rule"] for r in rows if r["rule"]), "round_robin")
                options = [r["resource"] for r in rows if r["resource"]]
                step: Dict[str, Any] = {"operation": operation, "duration": duration,
                                        "resource": {"mode": mode, "options": options}}
                if mode == "percentage":
                    step["resource"]["weights"] = [_safe_float(r["weight_raw"], 1) for r in rows]
                elif mode == "condition":
                    step["resource"]["rules"] = [
                        {"if": f"variant_type=='{_clean_str(r['weight_raw'])}'", "resource": r["resource"]}
                        for r in rows if _clean_str(r["weight_raw"])
                    ]
                    step["resource"]["default"] = options[0] if options else None
                steps.append(step)
            flow[variant] = steps
        return flow

    def parse_variant_quantities(self, source: Union[str, bytes]) -> Dict[str, int]:
        """
        Expected columns: Variant, Quantity
        Variant names are normalised to lowercase for consistent matching.
        """
        records = self.parse(source)
        result = {}
        for r in records:
            variant = _clean_str(r.get("Variant", r.get("variant"))).lower()
            if not variant:
                continue  # skip blank/trailing rows
            result[variant] = _safe_int(r.get("Quantity", r.get("quantity")), 0)
        return result

    def parse_variant_intervals(self, source: Union[str, bytes]) -> Dict[str, float]:
        """
        Optional 'Interval' column on the same Variant Quantities sheet — minutes
        between successive job arrivals for that variant (fixed/deterministic
        spacing). Variants with no Interval column/value are simply absent from
        the returned dict, meaning "no pacing" (all jobs spawn immediately),
        which is the existing default behaviour.
        """
        records = self.parse(source)
        result = {}
        for r in records:
            variant = _clean_str(r.get("Variant", r.get("variant"))).lower()
            if not variant:
                continue  # skip blank/trailing rows
            interval = _safe_float(_find_col(r, "Interval", "interval"), 0)
            if interval > 0:
                result[variant] = interval
        return result

    def parse_setup_matrix(self, source: Union[str, bytes]) -> Dict[str, Dict[str, float]]:
        """
        Optional sheet/CSV: Station, From, To, Setup Time — a per-product-pair
        changeover matrix, e.g. switching a sewing station from "TShirt" to
        "Jeans" can take longer than switching to "Hoodie". Overrides the flat
        per-station "Setup time" column from parse_stations() whenever a
        matching (from, to) pair exists for that station; stations/pairs not
        listed here simply fall back to the flat value (existing behaviour),
        so this sheet is entirely optional and additive.

        Returns: {station: {"from|to": setup_time_minutes}}
        (from/to are lowercased variant names, joined with "|" as the dict
        key since JSON — used throughout storage/API — cannot have tuple
        keys; see sim_core.py's _setup_time_for for how this is consumed.)
        """
        records = self.parse(source)
        matrix: Dict[str, Dict[str, float]] = {}
        for row in records:
            if _is_blank_row(row):
                break
            station = _clean_str(_find_col(row, "Station", "station"))
            if not station:
                continue  # skip blank/trailing rows
            from_variant = _clean_str(_find_col(row, "From", "from")).lower()
            to_variant = _clean_str(_find_col(row, "To", "to")).lower()
            if not from_variant or not to_variant:
                continue
            setup_time = _safe_float(_find_col(row, "Setup Time", "setup_time", "setup time"), 0)
            matrix.setdefault(station, {})[f"{from_variant}|{to_variant}"] = setup_time
        return matrix
