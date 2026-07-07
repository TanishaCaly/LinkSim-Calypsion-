"""
Pydantic request/response schemas for LinkSim API.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Scenario schemas
# ---------------------------------------------------------------------------

class ScenarioCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    stations_data: Dict[str, Any] = Field(default_factory=dict)
    processflow_data: Dict[str, Any] = Field(default_factory=dict)
    variant_quantities: Dict[str, int] = Field(default_factory=dict)
    operators_data: Dict[str, Any] = Field(default_factory=dict)
    simulation_config: Dict[str, Any] = Field(default_factory=dict)
    source_filename: Optional[str] = None
    source_file: Optional[List[int]] = None


class ScenarioUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    stations_data: Optional[Dict[str, Any]] = None
    processflow_data: Optional[Dict[str, Any]] = None
    variant_quantities: Optional[Dict[str, int]] = None
    operators_data: Optional[Dict[str, Any]] = None
    simulation_config: Optional[Dict[str, Any]] = None


class ScenarioResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    created_at: datetime
    updated_at: datetime
    stations_data: Dict[str, Any]
    processflow_data: Dict[str, Any]
    variant_quantities: Dict[str, int]
    operators_data: Dict[str, Any]
    simulation_config: Dict[str, Any]

    model_config = {"from_attributes": True}


class ScenarioListItem(BaseModel):
    id: int
    name: str
    description: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Run schemas
# ---------------------------------------------------------------------------

class RunRequest(BaseModel):
    num_replications: int = Field(default=1, ge=1, le=30)
    sim_config_override: Dict[str, Any] = Field(
        default_factory=dict,
        description="Partial sim config that overrides the scenario's stored config. "
                    "Supports: SIM_TIME, SHIFT_DURATION, SHIFT_1_START/END, "
                    "SHIFT_2_START/END, SHIFT_3_START/END, STATION_DOWNTIME, ACTIVE_PROCESSING_TIME.",
    )


class StationStatResponse(BaseModel):
    station_name: str
    station_utilization: float
    operator_utilization: float
    rework_percentage: float
    rework_time_ratio: float = 0.0
    completed_jobs: int
    throughput: float = 0.0
    busy_time: float
    avg_block_time: float
    failure_breakdowns: int
    pm_breakdowns: int
    top_bottleneck_type: Optional[str]
    top_bottleneck_metric: Optional[str]

    model_config = {"from_attributes": True}


class RunResponse(BaseModel):
    id: int
    scenario_id: int
    status: str
    created_at: datetime
    completed_at: Optional[datetime]
    completed_jobs: Optional[int]
    in_progress_jobs: Optional[int] = 0
    simulation_time: Optional[float]
    num_replications: int
    error_message: Optional[str]

    # Pre-computed KPIs from backend
    kpi_throughput: Optional[float] = None
    kpi_avg_utilization: Optional[float] = None
    kpi_peak_utilization: Optional[float] = None
    kpi_bottleneck_station: Optional[str] = None
    kpi_stations_at_risk: Optional[int] = None
    kpi_total_failures: Optional[int] = None
    kpi_avg_rework_pct: Optional[float] = None
    kpi_sim_days: Optional[float] = None

    model_config = {"from_attributes": True}


class RunDetailResponse(RunResponse):
    result: Optional[Dict[str, Any]]
    station_stats: List[StationStatResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Upload schemas
# ---------------------------------------------------------------------------

class UploadResponse(BaseModel):
    stations: Dict[str, Any]
    operators: Dict[str, Any]
    processflow: Dict[str, Any]
    variant_quantities: Dict[str, int]
    simulation_config: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Insights schema
# ---------------------------------------------------------------------------

class InsightsRequest(BaseModel):
    run_id: int


class InsightsResponse(BaseModel):
    run_id: int
    insights: Dict[str, Any]
