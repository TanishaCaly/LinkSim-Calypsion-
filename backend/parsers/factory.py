"""
Parser factory -- dispatches to csv/excel/yaml based on file extension.
"""
import os
from typing import Any, Dict, Optional, Union

from .csv_parser import CsvParser
from .excel_parser import ExcelParser
from .yaml_parser import YamlParser
from .flat_csv_parser import FlatCsvParser


class ParserFactory:
    _csv      = CsvParser()
    _excel    = ExcelParser()
    _yaml     = YamlParser()
    _flat_csv = FlatCsvParser()

    @classmethod
    def parse_all(cls, source: Union[str, bytes], filename: Optional[str] = None) -> Dict[str, Any]:
        ext = _detect_extension(source, filename)
        if ext in (".yaml", ".yml"):
            return cls._yaml.parse_all(source)
        if ext in (".xlsx", ".xls"):
            return cls._excel.parse_all(source)
        raise ValueError(
            f"Unsupported format: {ext}. Use .yaml, .xlsx, or pass individual CSV files "
            "via parse_csv_bundle()."
        )

    @classmethod
    def parse_csv_bundle(
        cls,
        stations: Union[str, bytes],
        operators: Union[str, bytes],
        processflow: Union[str, bytes],
        quantities: Union[str, bytes],
    ) -> Dict[str, Any]:
        return {
            "stations":           cls._csv.parse_stations(stations),
            "operators":          cls._csv.parse_operators(operators),
            "processflow":        cls._csv.parse_processflow(processflow),
            "variant_quantities": cls._csv.parse_variant_quantities(quantities),
        }

    @classmethod
    def parse_flat_csv(cls, source: Union[str, bytes]) -> Dict[str, Any]:
        """
        Parse a single flat process-routing CSV
        (Part_Name / Machine / Cycle_Time format).
        Stations and quantities are auto-derived.
        """
        return cls._flat_csv.parse_all(source)

    @classmethod
    def parse_simulation_config(cls, source: Union[str, bytes], filename: Optional[str] = None) -> Dict[str, Any]:
        ext = _detect_extension(source, filename)
        if ext in (".yaml", ".yml"):
            return cls._yaml.parse_simulation_config(source)
        raise ValueError("Simulation config can only be parsed from YAML.")


def _detect_extension(source: Union[str, bytes], filename: Optional[str]) -> str:
    if filename:
        _, ext = os.path.splitext(filename.lower())
        return ext
    if isinstance(source, str):
        _, ext = os.path.splitext(source.strip().lower())
        if ext:
            return ext
        if source.strip().startswith(("---", "scenario:", "simulation_config:")):
            return ".yaml"
    return ".unknown"
