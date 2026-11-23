"""
Database engine + session factory. LinkSim runs on PostgreSQL only: the
address comes from the DATABASE_URL environment variable (.env), e.g.
postgresql+psycopg://linksim:<password>@127.0.0.1:5432/linksim
The desktop build starts its own private PostgreSQL and sets it
(packaging/desktop_launcher.py).
"""
import os
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, Session
from typing import Generator

from .models import Base

DATABASE_URL: str = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set. Add your PostgreSQL address to .env, e.g. "
                       "DATABASE_URL=postgresql+psycopg://linksim:<password>@127.0.0.1:5432/linksim")
if not DATABASE_URL.startswith(("postgresql://", "postgresql+")):
    raise RuntimeError("DATABASE_URL must be a PostgreSQL address (postgresql+psycopg://...). "
                       "Fix it in .env.")

engine = create_engine(DATABASE_URL, pool_pre_ping=True, echo=False)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db():
    """Create all tables (idempotent — safe to call on every startup)."""
    Base.metadata.create_all(bind=engine)
    _migrate_users_table()
    _migrate_station_stats_table()
    _migrate_scenarios_table()


def _migrate_users_table():
    """SQLAlchemy's create_all doesn't add columns to an already-existing
    table, so new User columns (added after the table was first
    created) need a one-time ALTER TABLE. Idempotent — checks first."""
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("users")}
    statements = []
    if "email" not in existing:
        statements.append("ALTER TABLE users ADD COLUMN email VARCHAR(255)")
    if "is_active" not in existing:
        statements.append("ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _migrate_station_stats_table():
    """create_all doesn't add columns to an already-existing table —
    one-time ALTER TABLE for columns added after station_stats already
    existed in deployed DBs. Idempotent."""
    inspector = inspect(engine)
    if "station_stats" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("station_stats")}
    statements = []
    if "failure_counts_per_machine" not in existing:
        statements.append("ALTER TABLE station_stats ADD COLUMN failure_counts_per_machine JSON")
    if "rack_lane_count" not in existing:
        statements.append("ALTER TABLE station_stats ADD COLUMN rack_lane_count INTEGER")
    if "rack_occupied" not in existing:
        statements.append("ALTER TABLE station_stats ADD COLUMN rack_occupied INTEGER")
    for col in ("conveyor_length", "conveyor_speed", "transport_time"):
        if col not in existing:
            statements.append(f"ALTER TABLE station_stats ADD COLUMN {col} FLOAT")
    if "sensor_passed" not in existing:
        statements.append("ALTER TABLE station_stats ADD COLUMN sensor_passed INTEGER")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _migrate_scenarios_table():
    """One-time ALTER TABLE for scenario columns added after the table
    already existed in deployed DBs. Idempotent."""
    inspector = inspect(engine)
    if "scenarios" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("scenarios")}
    if "canvas_layout" not in existing:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE scenarios ADD COLUMN canvas_layout JSON"))


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency — yields a DB session, closes on exit."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
