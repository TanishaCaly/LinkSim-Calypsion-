"""
YAML parser — for LinkSim scenario / config files.

YAML format supports:
  - simulation_config   (SIM_TIME, shifts, etc.)
  - stations            (inline station definitions)
  - operators
  - processflow
  - variant_quantities

Also supports a "scenario" top-level key that bundles everything.
"""
import io
import yaml
from typing import Any, Dict, List, Optional, Union

from .csv_parser import _safe_int


class YamlParser:

    def parse(self, source: Union[str, bytes]) -> Dict[str, Any]:
        """Load raw YAML and return the top-level dict."""
        try:
            if isinstance(source, bytes):
                text = source.decode("utf-8")
            else:
                # Check if it's a file path (no newlines, ends with .yaml/.yml)
                stripped = source.strip()
                if "\n" not in stripped and stripped.endswith((".yaml", ".yml")):
                    with open(stripped, "r", encoding="utf-8") as f:
                        text = f.read()
                else:
                    text = source
            return yaml.safe_load(text) or {}
        except Exception as exc:
            raise ValueError(f"YAML parse error: {exc}") from exc

    def parse_simulation_config(self, source: Union[str, bytes]) -> Dict[str, Any]:
        """Extract simulation_config block."""
        data = self.parse(source)
        # Support nested under 'scenario' key
        if "scenario" in data:
            data = data["scenario"]
        cfg = data.get("simulation_config", data)
        return _coerce_sim_config(cfg)

    def parse_stations(self, source: Union[str, bytes]) -> Dict[str, Dict]:
        data = self.parse(source)
        if "scenario" in data:
            data = data["scenario"]
        raw = data.get("stations", {})
        if isinstance(raw, list):
            # List of dicts with 'name' key
            return {s["name"]: {k: v for k, v in s.items() if k != "name"} for s in raw if "name" in s}
        return raw

    def parse_operators(self, source: Union[str, bytes]) -> Dict[str, Dict]:
        data = self.parse(source)
        if "scenario" in data:
            data = data["scenario"]
        raw = data.get("operators", {})
        if isinstance(raw, list):
            return {op["name"]: {k: v for k, v in op.items() if k != "name"} for op in raw if "name" in op}
        return raw

    def parse_processflow(self, source: Union[str, bytes]) -> Dict[str, List[Dict]]:
        data = self.parse(source)
        if "scenario" in data:
            data = data["scenario"]
        return data.get("processflow", {})

    def parse_variant_quantities(self, source: Union[str, bytes]) -> Dict[str, int]:
        data = self.parse(source)
        if "scenario" in data:
            data = data["scenario"]
        return {str(k): _safe_int(v, 0) for k, v in data.get("variant_quantities", {}).items() if k}

    def parse_all(self, source: Union[str, bytes]) -> Dict[str, Any]:
        """Parse a full scenario YAML into all LinkSim inputs."""
        data = self.parse(source)
        if "scenario" in data:
            data = data["scenario"]
        return {
            "simulation_config": _coerce_sim_config(data.get("simulation_config", {})),
            "stations": self.parse_stations(source),
            "operators": self.parse_operators(source),
            "processflow": data.get("processflow", {}),
            "variant_quantities": {str(k): _safe_int(v, 0) for k, v in data.get("variant_quantities", {}).items() if k},
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SIM_CONFIG_DEFAULTS = {
    "SIM_TIME": 10080,       # 7 days in minutes
    "SHIFT_DURATION": 480,   # 8 hours
    "SHIFT_1_START": 6.0,
    "SHIFT_1_END": 14.0,
    "SHIFT_2_START": 14.0,
    "SHIFT_2_END": 22.0,
    "SHIFT_3_START": 22.0,
    "SHIFT_3_END": 6.0,
    "STATION_DOWNTIME": 0,
    "ACTIVE_PROCESSING_TIME": 480,
}


def _coerce_sim_config(cfg: Dict) -> Dict[str, Any]:
    result = dict(_SIM_CONFIG_DEFAULTS)
    result.update({k: float(v) if isinstance(v, (int, float)) else v for k, v in cfg.items()})
    # Ensure SIM_TIME and SHIFT_DURATION are floats
    for key in ("SIM_TIME", "SHIFT_DURATION"):
        result[key] = float(result[key])
    return result
