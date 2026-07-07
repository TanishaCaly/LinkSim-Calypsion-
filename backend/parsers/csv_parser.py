"""
CSV parser -- adapted from UpdatedSimulationProject/parsers/csv_parser.py.
Removed Dash base64 encoding. Accepts file paths OR raw string content.
"""
import io
import math
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


def _find_col(row: Dict[str, Any], *candidates: str) -> Any:
    """
    Look up a value in a row dict by trying each candidate key, first as an
    exact match, then as a case-insensitive substring match against the
    row's actual column names. This lets slightly-renamed headers still map
    correctly — e.g. a column literally named "Capacity (machines)" or
    "Repair Time (min)" should still be found when we ask for "capacity" or
    "repair time", instead of silently falling back to the default value.
    """
    # Exact match first (fast path, preserves existing behaviour)
    for cand in candidates:
        if cand in row:
            return row[cand]
    # Fuzzy: row column contains the candidate as a substring (case-insensitive)
    lower_keys = {str(k).strip().lower(): k for k in row.keys()}
    for cand in candidates:
        cand_lower = cand.strip().lower()
        for lk, original_key in lower_keys.items():
            if cand_lower and cand_lower in lk:
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
        Failure rate, Repair Time, PM Schedule, Material Shortage Probability (%),
        Rework Probability (%), shift1, shift2, shift3, STATION_DOWNTIME

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
        Returns: {variant: [{operation, resource, duration}, ...]}
        Variant names are normalised to lowercase for consistent matching.
        """
        records = self.parse(source)
        flow: Dict[str, List[Dict]] = {}
        for row in records:
            variant = _clean_str(row.get("Variant", row.get("variant"))).lower()
            if not variant:
                continue  # skip blank/trailing rows
            flow.setdefault(variant, []).append({
                "operation": _clean_str(row.get("Operation", row.get("operation"))),
                "resource": _clean_str(row.get("Resource", row.get("resource"))),
                "duration": _safe_float(row.get("Duration", row.get("duration")), 0),
            })
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
