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

from .csv_parser import _safe_int, _safe_float


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

    def parse_variant_intervals(self, source: Union[str, bytes]) -> Dict[str, float]:
        """Optional 'variant_intervals' block — minutes between job arrivals per variant."""
        data = self.parse(source)
        if "scenario" in data:
            data = data["scenario"]
        return {str(k): _safe_float(v, 0) for k, v in data.get("variant_intervals", {}).items() if k}

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
            "variant_intervals": {str(k): _safe_float(v, 0) for k, v in data.get("variant_intervals", {}).items() if k},
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
    # One default break per shift, roughly mid-shift, so a run has a
    # realistic rest/lunch break out of the box even if the user never
    # opens Simulation Config to add one. A scenario/override that sets its
    # own BREAKS_n replaces this entirely — see SimulationUtils.breaks().
    "BREAKS_1": [{"start": 10.0, "duration": 30}],
    "BREAKS_2": [{"start": 18.0, "duration": 30}],
    "BREAKS_3": [{"start": 2.0, "duration": 30}],
}


def _coerce_sim_config(cfg: Dict) -> Dict[str, Any]:
    # Deep-copy list/dict defaults (e.g. BREAKS_n) so nothing downstream can
    # accidentally mutate the shared _SIM_CONFIG_DEFAULTS across runs.
    result = {k: (list(v) if isinstance(v, list) else v) for k, v in _SIM_CONFIG_DEFAULTS.items()}
    result.update({k: float(v) if isinstance(v, (int, float)) else v for k, v in cfg.items()})
    # Ensure SIM_TIME and SHIFT_DURATION are floats
    for key in ("SIM_TIME", "SHIFT_DURATION"):
        result[key] = float(result[key])
    return result
