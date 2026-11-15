"""
SQLAlchemy ORM models for LinkSim.
SQLite in dev; switch DATABASE_URL to PostgreSQL for production.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON, Boolean, Column, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, create_engine
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    """
    A LinkSim account. Demo-scope: username/password only, no roles yet —
    every user simply owns their own scenarios (see Scenario.user_id) and
    cannot see anyone else's. Admin/role-based access is a later phase.

    is_active is a manual kill-switch (e.g. for banning an account; see
    backend/scripts/set_user_active.py). Access to LinkSim itself comes from
    the license (backend/licensing.py).
    """
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), nullable=False, unique=True, index=True)
    email = Column(String(255), nullable=True, unique=True, index=True)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, nullable=False, default=True)


class UserLicense(Base):
    """
    Web version (LINKSIM_LICENSE=user): the license key a user entered and the
    last good signed token from the licensing server (see backend/licensing.py).
    fingerprint is a random ID for this account — the licensing server counts
    one seat per account by it.
    """
    __tablename__ = "user_licenses"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    fingerprint = Column(String(64), nullable=False)
    license_key = Column(String(64), nullable=True)
    envelope = Column(JSON, nullable=True)
    # Highest wall-clock time seen, for clock rollback detection.
    last_seen = Column(Float, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Scenario(Base):
    """
    A simulation scenario: one complete set of inputs (stations, operators, flow, config).
    Multiple SimulationRun records belong to one Scenario.
    """
    __tablename__ = "scenarios"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Nullable so scenarios created before multi-user support (or via any
    # future admin/import path with no acting user) don't break — but every
    # scenario created through the normal API from here on is always stamped
    # with the creating user's id, and every list/get/update/delete query
    # filters on it so users never see each other's scenarios.
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
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
    # The Build canvas drawing exactly as the user left it — boxes (fixed
    # id, name, type, position) and lines (with the products using each).
    # Canvas-only: the engine reads stations_data / processflow_data.
    # NULL for scenarios never saved from the Canvas since this existed.
    canvas_layout = Column(JSON, nullable=True)

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
    # Only set for a Buffer node run in 3D mode (see sim_core.py's
    # _init_rack_buffers) — NULL for every 2D/scalar station, meaning
    # buffer_capacity above is the real, active number for that one instead.
    rack_lane_count = Column(Integer, nullable=True)
    rack_occupied = Column(Integer, nullable=True)
    completed_jobs = Column(Integer, default=0)
    throughput = Column(Float, default=0.0)
    busy_time = Column(Float, default=0.0)
    avg_block_time = Column(Float, default=0.0)
    failure_breakdowns = Column(Integer, default=0)
    # Each sub-machine's own failure count (e.g. [29, 28] for capacity=2) —
    # lets dashboard KPIs (MTBF, Availability) compute per-machine values
    # instead of treating the pooled total as if one failure stopped the
    # whole station, which is only true at capacity=1. NULL for runs
    # recorded before this column existed.
    failure_counts_per_machine = Column(JSON, nullable=True)
    pm_breakdowns = Column(Integer, default=0)
    operator_per_station = Column(Integer, default=1)
    capacity = Column(Integer, default=1)
    # Conveyor only (m, m/min, min) — NULL for every other station.
    conveyor_length = Column(Float, nullable=True)
    conveyor_speed = Column(Float, nullable=True)
    transport_time = Column(Float, nullable=True)
    # Jobs that passed the conveyor's sensor — NULL when it has no sensor.
    sensor_passed = Column(Integer, nullable=True)
    avg_cycle_time = Column(Float, default=0.0)
    max_cycle_time = Column(Float, default=0.0)

    # Bottleneck summary (top issue type)
    top_bottleneck_type = Column(String(100), nullable=True)
    top_bottleneck_metric = Column(String(200), nullable=True)

    run = relationship("SimulationRun", back_populates="station_stats")
