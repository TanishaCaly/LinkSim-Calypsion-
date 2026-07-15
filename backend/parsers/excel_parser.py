"""
Excel parser -- reads multi-sheet .xlsx files for LinkSim.

Supported sheet layouts:
  1. Standard (4-sheet):
       Stations | Operators | ProcessFlow | VariantQuantities
  2. User format (InputFileB-style):
       Stations | Process Flow - Variant1 | Process Flow - Variant2 | Variant Quantities
       (Operators sheet optional; variant name derived from sheet suffix)

Falls back gracefully if any sheet is missing.
Variant names are normalised to lowercase throughout for consistent matching.
"""
import io
import re
import pandas as pd
from typing import Dict, List, Any, Union, Optional

from .csv_parser import CsvParser, _clean_str, _safe_float, _find_col, _is_blank_row

_csv = CsvParser()


class ExcelParser:
    DEFAULT_SHEETS = {
        "stations":    "Stations",
        "operators":   "Operators",
        "processflow": "ProcessFlow",
        "quantities":  "VariantQuantities",
    }

    ALIASES = {
        "stations":     ["stations", "station"],
        "operators":    ["operators", "operator"],
        "processflow":  ["processflow", "process flow", "processflows"],
        "quantities":   ["variantquantities", "variant quantities", "quantities", "variant_quantities"],
        "setup_matrix": ["setupmatrix", "setup matrix", "setup_matrix", "changeover matrix"],
    }

    def __init__(self, sheet_names=None):
        self.sheet_names = {**self.DEFAULT_SHEETS, **(sheet_names or {})}

    # Column-name keywords we look for when auto-detecting which row is the
    # real header (case-insensitive substring match).
    _HEADER_KEYWORDS = [
        "station", "capacity", "operator", "variant", "operation", "resource",
        "duration", "quantity", "skill", "availability", "failure", "repair",
    ]

    def _load(self, source):
        """
        Returns each sheet as a dict with both:
          - "main": the sheet's primary table, header-promoted (see
            _promote_header_row) — used for the common case of one table
            per sheet.
          - "raw": the completely unprocessed (header=None) DataFrame — used
            by `_find_subtable` to locate a SECOND table embedded further
            down the same sheet (e.g. a "VARIANT QUANTITIES" mini-table
            placed below the main Simulation Config table).
        """
        try:
            if isinstance(source, bytes):
                raw_sheets = pd.read_excel(io.BytesIO(source), sheet_name=None, header=None)
            else:
                raw_sheets = pd.read_excel(source, sheet_name=None, header=None)
        except Exception as exc:
            raise ValueError(f"Excel read error: {exc}") from exc

        return {
            name: {"main": self._promote_header_row(df), "raw": df}
            for name, df in raw_sheets.items()
        }

    def _promote_header_row(self, df):
        """
        Re-reads a sheet's actual header row instead of always assuming row 0.
        Users often add a title row (e.g. "STATIONS (capacity = ...)") followed
        by a blank spacer row before the real column headers — plain
        `pd.read_excel` would otherwise treat the title as the header and every
        real column as "Unnamed: N", silently producing an empty parse.
        """
        if df.empty:
            return df

        max_scan = min(10, len(df))
        for row_idx in range(max_scan):
            row_values = [str(v).strip().lower() for v in df.iloc[row_idx].tolist() if pd.notna(v)]
            if len(row_values) < 2:
                continue
            keyword_hits = sum(1 for v in row_values if any(kw in v for kw in self._HEADER_KEYWORDS))
            if keyword_hits >= 2:
                header = df.iloc[row_idx].tolist()
                body = df.iloc[row_idx + 1:].copy()
                body.columns = [str(h).strip() if pd.notna(h) else f"col_{i}" for i, h in enumerate(header)]
                return body.reset_index(drop=True)

        # No recognizable header row found in the first few rows — fall back to
        # treating row 0 as the header (original behaviour) so well-formed
        # files without any of our keywords still work as before.
        body = df.iloc[1:].copy()
        body.columns = [str(h).strip() if pd.notna(h) else f"col_{i}" for i, h in enumerate(df.iloc[0].tolist())]
        return body.reset_index(drop=True)

    def _find_subtable(self, sheets, required_keywords):
        """
        Scan every sheet's RAW rows (not just the sheet's main/first table)
        for a header row whose cells match all of `required_keywords`
        (case-insensitive substring match on each). This finds a second,
        embedded mini-table further down a sheet — e.g. a "Variant / Quantity"
        table placed below the main Simulation Config table, separated only
        by a blank spacer row rather than living in its own sheet.
        Returns a DataFrame of just that sub-table's rows, or None.
        """
        for sname, entry in sheets.items():
            raw = entry["raw"] if isinstance(entry, dict) else entry
            if raw is None or raw.empty:
                continue
            max_scan = len(raw)
            for row_idx in range(max_scan):
                row_values = [str(v).strip().lower() for v in raw.iloc[row_idx].tolist() if pd.notna(v)]
                if len(row_values) < len(required_keywords):
                    continue
                if all(any(kw in v for v in row_values) for kw in required_keywords):
                    header = raw.iloc[row_idx].tolist()
                    body = raw.iloc[row_idx + 1:].copy()
                    body.columns = [str(h).strip() if pd.notna(h) else f"col_{i}" for i, h in enumerate(header)]
                    # Stop the sub-table at the next fully-blank row (or end of sheet)
                    end = len(body)
                    for i in range(len(body)):
                        if body.iloc[i].isna().all():
                            end = i
                            break
                    return body.iloc[:end].reset_index(drop=True)
        return None

    @staticmethod
    def _main_df(entry):
        """Unwrap a sheets-dict entry to its 'main' DataFrame, whether it's
        the new {"main":..., "raw":...} shape or a plain DataFrame."""
        return entry["main"] if isinstance(entry, dict) and "main" in entry else entry

    def _find_sheet(self, sheets, key):
        exact = self.sheet_names.get(key)
        if exact and exact in sheets:
            return self._main_df(sheets[exact])
        aliases = self.ALIASES.get(key, [])
        for sname, entry in sheets.items():
            if sname.strip().lower() in aliases:
                return self._main_df(entry)
        return None

    def _find_variant_sheets(self, sheets):
        pattern = re.compile(r"^process\s+flow\s*[-]+\s*(.+)$", re.IGNORECASE)
        result = {}
        for sname, entry in sheets.items():
            m = pattern.match(sname.strip())
            df = self._main_df(entry)
            if m and df is not None and not df.empty:
                variant = m.group(1).strip()
                result[variant] = df
        return result

    def parse_all(self, source):
        sheets = self._load(source)
        return {
            "stations":           self.parse_stations(sheets),
            "operators":          self.parse_operators(sheets),
            "processflow":        self.parse_processflow(sheets),
            "variant_quantities": self.parse_variant_quantities(sheets),
            "variant_intervals":  self.parse_variant_intervals(sheets),
            "setup_matrix":       self.parse_setup_matrix(sheets),
        }

    def parse_stations(self, source):
        df = self._resolve(source, "stations")
        if df is None:
            return {}
        return _csv.parse_stations(df.to_csv(index=False))

    def parse_operators(self, source):
        df = self._resolve(source, "operators")
        if df is None:
            return {}
        return _csv.parse_operators(df.to_csv(index=False))

    def parse_processflow(self, source):
        sheets = source if isinstance(source, dict) else self._load(source)

        # Layout A: standard single sheet with Variant column
        df_single = self._find_sheet(sheets, "processflow")
        if df_single is not None and not df_single.empty:
            cols_lower = [c.lower() for c in df_single.columns]
            if "variant" in cols_lower:
                return _csv.parse_processflow(df_single.to_csv(index=False))

        # Layout B: multiple "Process Flow - VariantN" sheets
        variant_dfs = self._find_variant_sheets(sheets)
        if variant_dfs:
            flow = {}
            for variant_name, df in variant_dfs.items():
                # Normalise variant name to lowercase for consistent matching
                key = variant_name.lower()
                steps = self._extract_flow_steps(df)
                if steps:
                    flow[key] = steps
            return flow

        # Fallback: single sheet without Variant column
        if df_single is not None and not df_single.empty:
            steps = self._extract_flow_steps(df_single)
            if steps:
                return {"variant1": steps}

        return {}

    def _extract_flow_steps(self, df):
        """
        Pull {operation, resource, duration} rows out of a process-flow-style
        sheet. Column names are matched loosely (case-insensitive substring),
        so headers like "Resource (Station)" or "Duration (min)" still map
        to the right field instead of silently coming back blank/zero.
        """
        records = df.to_dict("records")
        steps = []
        for row in records:
            if _is_blank_row(row):
                break  # stop at a spacer row; anything after is not data
            operation = _clean_str(_find_col(row, "operation", "operation name"))
            resource  = _clean_str(_find_col(row, "resource", "station", "machine"))
            duration  = _safe_float(_find_col(row, "duration", "cycle time", "cycle_time"), 0)
            if operation:
                steps.append({"operation": operation, "resource": resource, "duration": duration})
        return steps

    def parse_variant_quantities(self, source):
        sheets = source if isinstance(source, dict) else self._load(source)
        df = self._find_sheet(sheets, "quantities")
        if df is None:
            # No dedicated sheet — look for a "Variant / Quantity" mini-table
            # embedded further down another sheet (e.g. under Sim Config).
            df = self._find_subtable(sheets, ["variant", "quantity"])
        if df is None or df.empty:
            return {}
        return _csv.parse_variant_quantities(df.to_csv(index=False))

    def parse_variant_intervals(self, source):
        """Optional 'Interval' column on the same Variant Quantities sheet/table."""
        sheets = source if isinstance(source, dict) else self._load(source)
        df = self._find_sheet(sheets, "quantities")
        if df is None:
            df = self._find_subtable(sheets, ["variant", "quantity"])
        if df is None or df.empty:
            return {}
        return _csv.parse_variant_intervals(df.to_csv(index=False))

    def parse_setup_matrix(self, source):
        """Optional 'Setup Matrix' sheet: Station, From, To, Setup Time —
        entirely absent from most files, which is fine (returns {})."""
        df = self._resolve(source, "setup_matrix")
        if df is None or df.empty:
            return {}
        return _csv.parse_setup_matrix(df.to_csv(index=False))

    def _resolve(self, source, key):
        sheets = source if isinstance(source, dict) else self._load(source)
        return self._find_sheet(sheets, key)
