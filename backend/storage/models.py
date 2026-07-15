"""
SQLAlchemy ORM models for LinkSim.
SQLite in dev; switch DATABASE_URL to PostgreSQL for production.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON, Column, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, create_engine
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class Scenario(Base):
    """
    A simulation scenario: one complete set of inputs (stations, operators, flow, config).
    Multiple SimulationRun records belong to one Scenario.
    """
    __tablename__ = "scenarios"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Original uploaded file (bytes + filename) for later download
    source_filename = Column(String(500), nullable=True)
    source_file = Column(LargeBinary, nullable=True)

    # Serialised input blobs
    stations_data = Column(JSON, nullable=False, default=dict)
    processflow_data = Column(JSON, nullable=False, default=dict)
    variant_quantities = Column(JSON, nullable=False, default=dict)
    variant_intervals = Column(JSON, nullable=False, default=dict)
    setup_matrix = Column(JSON, nullable=False, default=dict)
    operators_data = Column(JSON, nullable=False, default=dict)
    simulation_config = Column(JSON, nullable=False, default=dict)

    runs = relationship("SimulationRun", back_populates="scenario", cascade="all, delete-orphan")


class SimulationRun(Base):
    """
    One execution of a Scenario (possibly one of N replications).
    Stores summary stats + full result blob.
    """
    __tablename__ = "simulation_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scenario_id = Column(Integer, ForeignKey("scenarios.id"), nullable=False)
    status = Column(String(20), default="pending")   # pending | running | completed | failed
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    # Top-level KPIs stored for quick list views
    completed_jobs = Column(Integer, nullable=True)
    in_progress_jobs = Column(Integer, nullable=True, default=0)
    simulation_time = Column(Float, nullable=True)
    num_replications = Column(Integer, default=1)

    # Pre-computed summary KPIs (so frontend just reads, never calculates)
    kpi_throughput = Column(Float, nullable=True)
    kpi_avg_utilization = Column(Float, nullable=True)
    kpi_peak_utilization = Column(Float, nullable=True)
    kpi_bottleneck_station = Column(String(200), nullable=True)
    kpi_stations_at_risk = Column(Integer, nullable=True)
    kpi_total_failures = Column(Integer, nullable=True)
    kpi_avg_rework_pct = Column(Float, nullable=True)
    kpi_sim_days = Column(Float, nullable=True)

    # Full result blob
    result = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)

    scenario = relationship("Scenario", back_populates="runs")
    station_stats = relationship("StationStat", back_populates="run", cascade="all, delete-orphan")


class StationStat(Base):
    """
    Per-station summary row for a simulation run.
    Denormalised for fast frontend queries (e.g. "show utilisation for all stations").
    """
    __tablename__ = "station_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, ForeignKey("simulation_runs.id"), nullable=False)
    station_name = Column(String(200), nullable=False)

    station_utilization = Column(Float, default=0.0)
    operator_utilization = Column(Float, default=0.0)
    rework_percentage = Column(Float, default=0.0)
    rework_time_ratio = Column(Float, default=0.0)
    setup_time_ratio = Column(Float, default=0.0)
    total_setup_time = Column(Float, default=0.0)
    buffer_blocked_ratio = Column(Float, default=0.0)
    buffer_blocked_time = Column(Float, default=0.0)
    buffer_capacity = Column(Integer, default=0)
    buffer_discipline = Column(String(10), default="FIFO")
    completed_jobs = Column(Integer, default=0)
    throughput = Column(Float, default=0.0)
    busy_time = Column(Float, default=0.0)
    avg_block_time = Column(Float, default=0.0)
    failure_breakdowns = Column(Integer, default=0)
    pm_breakdowns = Column(Integer, default=0)
    operator_per_station = Column(Integer, default=1)
    capacity = Column(Integer, default=1)

    # Bottleneck summary (top issue type)
    top_bottleneck_type = Column(String(100), nullable=True)
    top_bottleneck_metric = Column(String(200), nullable=True)

    run = relationship("SimulationRun", back_populates="station_stats")
