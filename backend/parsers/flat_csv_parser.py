"""
Flat CSV parser — handles single-file process routing CSVs.

Expected columns (case-insensitive):
  Part_Name | Part_Number | Annual_Volume | Process_Name | Machine | Process_Time

Mapping to LinkSim internals:
  Part_Name   → variant name
  Process_Name → operation name
  Machine      → resource / station name
  Process_Time → operation duration (minutes the machine works on one job;
                 a Cycle_Time column is never read as the process time)
  Annual_Volume → variant quantity (divided by WORKING_DAYS_PER_YEAR to get
                  a daily target; rounded to nearest integer, minimum 1)

Stations are auto-discovered from unique Machine values.
Default station params are used for Failure rate, PM Schedule, etc.
"""
import io
import math
from typing import Any, Dict, List, Union

import pandas as pd

from .csv_parser import _clean_str, _safe_float


# How many working days per year to normalise annual volume
WORKING_DAYS_PER_YEAR: int = 250


class FlatCsvParser:
    """Parse a single process-routing CSV into LinkSim scenario dicts."""

    def parse(self, source: Union[str, bytes]) -> pd.DataFrame:
        """Load CSV into a DataFrame with normalised column names."""
        if isinstance(source, bytes):
            df = pd.read_csv(io.BytesIO(source))
        else:
            df = pd.read_csv(io.StringIO(source))

        # Normalise column names: strip whitespace, lowercase
        df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
        return df

    REQUIRED_COLUMNS = ["part_name", "process_name", "machine", "process_time"]

    def parse_all(self, source: Union[str, bytes]) -> Dict[str, Any]:
        """
        Returns a full scenario dict:
        {
          stations, operators, processflow, variant_quantities
        }
        """
        df = self.parse(source)
        missing_cols = [c for c in self.REQUIRED_COLUMNS if c not in df.columns]
        if "process_time" in missing_cols and "cycle_time" in df.columns:
            raise ValueError(
                "Process_Time column not found — the Cycle_Time column is not used. "
                "Please add a 'Process_Time' column (minutes the machine works on one job)."
            )
        if missing_cols:
            raise ValueError(
                f"Missing required column(s): {', '.join(missing_cols)}. "
                f"Expected columns: Part_Name, Part_Number, Annual_Volume, Process_Name, Machine, Process_Time "
                f"(case-insensitive). Found: {', '.join(df.columns) or '(none)'}."
            )
        return {
            "stations":           self._extract_stations(df),
            "operators":          {},   # not present in flat format
            "processflow":        self._extract_processflow(df),
            "variant_quantities": self._extract_quantities(df),
            "variant_intervals":  {},   # not present in flat format
        }

    # ------------------------------------------------------------------
    # Section extractors
    # ------------------------------------------------------------------

    def _extract_stations(self, df: pd.DataFrame) -> Dict[str, Dict]:
        """
        Derive station list from unique Machine values.
        All simulation-specific fields (failure rate, etc.) get sensible defaults.
        """
        machines = df["machine"].dropna().unique()
        stations: Dict[str, Dict] = {}
        for machine in machines:
            name = _clean_str(machine)
            if not name:
                continue  # skip blank/trailing rows
            stations[name] = {
                "capacity":                      1,
                "shifts_per_day":                1,
                "operator_per_station":          1,
                "Failure rate":                  0,
                "Repair Time":                   10,
                "Setup time":                    0,
                "PM Schedule":                   "Monthly",
                "Failure Policy":                "resume",
                "Material Shortage Probability (%)": 0,
                "Rework Probability (%)":        10,
                "shift1":                        "",
                "shift2":                        "",
                "shift3":                        "",
                "STATION_DOWNTIME":              0,
            }
        return stations

    def _extract_processflow(self, df: pd.DataFrame) -> Dict[str, List[Dict]]:
        """
        Build {part_name: [{operation, resource, duration}, ...]}
        Preserves row order (= process sequence within each part).
        """
        flow: Dict[str, List[Dict]] = {}
        for _, row in df.iterrows():
            part     = _clean_str(row.get("part_name")).lower()
            op       = _clean_str(row.get("process_name"))
            resource = _clean_str(row.get("machine"))
            duration = _safe_float(row.get("process_time"), 0)
            if part and op:
                flow.setdefault(part, []).append({
                    "operation": op,
                    "resource":  resource,
                    "duration":  duration,
                })
        return flow

    def _extract_quantities(self, df: pd.DataFrame) -> Dict[str, int]:
        """
        Derive daily quantity from Annual_Volume / WORKING_DAYS_PER_YEAR.
        One row per part (takes the first occurrence of Annual_Volume).
        """
        quantities: Dict[str, int] = {}
        for _, row in df.iterrows():
            part = _clean_str(row.get("part_name")).lower()
            if not part or part in quantities:
                continue  # skip blank/trailing rows
            annual = _safe_float(row.get("annual_volume"), 0)
            daily = max(1, math.ceil(annual / WORKING_DAYS_PER_YEAR)) if annual > 0 else 1
            quantities[part] = daily
        return quantities
