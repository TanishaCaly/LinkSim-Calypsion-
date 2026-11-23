"""
One-time copy of the LinkSim SQLite database into an empty PostgreSQL database.

Usage:
    python -m backend.scripts.migrate_sqlite_to_postgres --sqlite linksim.db --postgres postgresql+psycopg://user:pass@host:5432/linksim

- The PostgreSQL tables are created from backend/storage/models.py, so the
  target gets exactly the current model's columns. Old SQLite-only columns
  (e.g. users.subscription_end_date) are reported and not copied.
- The SQLite file is opened read-only and is never changed.
- The target must be empty. The copy runs in one transaction: any error
  leaves the target tables empty.
- Original ids are kept and the id sequences are moved past them.
- Afterwards every row and every column is compared with the source; the
  script exits non-zero if anything differs.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import psycopg
from sqlalchemy import JSON, Boolean, DateTime, LargeBinary, create_engine

# Rows per fetch. simulation_runs.result can be over 100 MB, so one at a time.
_BATCH = {"simulation_runs": 1}
_DEFAULT_BATCH = 500


def _kind(col):
    t = col.type
    if isinstance(t, JSON):
        return "json"
    if isinstance(t, DateTime):
        return "datetime"
    if isinstance(t, Boolean):
        return "bool"
    if isinstance(t, LargeBinary):
        return "bytes"
    return "plain"


def _placeholder(kind):
    return {"json": "%s::json", "datetime": "%s::timestamp"}.get(kind, "%s")


def _to_pg(kind, v):
    if v is None:
        return None
    if kind == "bool":
        return bool(v)
    if kind == "bytes":
        return bytes(v)
    # JSON and datetime go over as their stored text, cast in SQL, so the
    # JSON text arrives byte-for-byte as SQLite had it.
    return v


def _same(kind, src, dst):
    if src is None or dst is None:
        return src is None and dst is None
    if kind == "datetime":
        return datetime.fromisoformat(src) == dst
    if kind == "bool":
        return bool(src) == dst
    if kind == "bytes":
        return bytes(src) == bytes(dst)
    return src == dst  # json compared as exact text (selected ::text)


def _pg_conninfo(url):
    for prefix in ("postgresql+psycopg://", "postgresql+psycopg2://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix):]
    return url


class MigrationError(Exception):
    pass


def _missing_value(col):
    """A column an older database doesn't have: its model default (a new
    empty {} / [] for JSON), else NULL."""
    d = col.default
    if d is None:
        return None
    arg = d.arg
    if callable(arg):
        # SQLAlchemy wraps model defaults (dict, datetime.utcnow) as f(context).
        try:
            v = arg(None)
        except TypeError:
            v = arg()
        return v.isoformat(sep=" ") if isinstance(v, datetime) else v
    return arg


def migrate(sqlite_path, postgres_url, log=print):
    """Copy every row of the SQLite file into the (empty) PostgreSQL database
    and verify it. Raises MigrationError if anything can't be copied or differs."""
    if not postgres_url.startswith(("postgresql", "postgres")):
        raise MigrationError("the target must be a PostgreSQL URL")
    src_path = Path(sqlite_path).resolve()
    if not src_path.is_file():
        raise MigrationError(f"SQLite file not found: {src_path}")

    # backend.storage needs DATABASE_URL set before it is imported.
    os.environ.setdefault("DATABASE_URL", postgres_url)
    from backend.storage.models import Base

    src = sqlite3.connect(f"file:{src_path.as_posix()}?mode=ro", uri=True)
    try:
        return _migrate(src, postgres_url, log, Base)
    finally:
        src.close()


def _migrate(src, postgres_url, log, Base):
    tables = Base.metadata.sorted_tables  # FK order: parents first

    # ── Source columns against the model. A table or column an older
    # LinkSim didn't have yet is filled with its default. ──
    present = {}
    for table in tables:
        src_cols = {r[1] for r in src.execute(f'PRAGMA table_info("{table.name}")')}
        present[table.name] = src_cols
        if not src_cols:
            log(f"Source has no {table.name} table (older LinkSim) — nothing to copy there")
            continue
        for c in table.columns:
            if c.name not in src_cols:
                log(f"Source has no {table.name}.{c.name} (older LinkSim) — filled with its default")
        for extra in sorted(src_cols - {c.name for c in table.columns}):
            n = src.execute(f'SELECT COUNT(*) FROM "{table.name}" WHERE "{extra}" IS NOT NULL').fetchone()[0]
            log(f"Not copied (not in models.py): {table.name}.{extra} ({n} non-null value(s))")

    # ── Create schema ──
    engine = create_engine(postgres_url)
    Base.metadata.create_all(bind=engine)
    engine.dispose()

    with psycopg.connect(_pg_conninfo(postgres_url)) as pg:
        # ── Target must be empty ──
        for table in tables:
            n = pg.execute(f'SELECT COUNT(*) FROM "{table.name}"').fetchone()[0]
            if n:
                raise MigrationError(f"target table {table.name} already has {n} rows — refusing to copy")

        # ── Copy (one transaction) ──
        with pg.transaction():
            for table in tables:
                if not present[table.name]:
                    continue
                cols = list(table.columns)
                have = [c for c in cols if c.name in present[table.name]]
                fill = {c.name: _missing_value(c) for c in cols if c.name not in present[table.name]}
                kinds = [_kind(c) for c in cols]
                names = ", ".join(f'"{c.name}"' for c in cols)
                insert = (f'INSERT INTO "{table.name}" ({names}) VALUES '
                          f'({", ".join(_placeholder(k) for k in kinds)})')
                pk = ", ".join(f'"{c.name}"' for c in table.primary_key.columns)
                cur = src.execute(f'SELECT {", ".join(chr(34) + c.name + chr(34) for c in have)} '
                                  f'FROM "{table.name}" ORDER BY {pk}')
                batch = _BATCH.get(table.name, _DEFAULT_BATCH)
                copied = 0
                with pg.cursor() as pc:
                    while rows := cur.fetchmany(batch):
                        out = []
                        for r in rows:
                            vals = dict(zip((c.name for c in have), r))
                            row = []
                            for c, k in zip(cols, kinds):
                                v = vals[c.name] if c.name in vals else fill[c.name]
                                if k == "json" and c.name not in vals and v is not None:
                                    v = json.dumps(v)
                                row.append(_to_pg(k, v))
                            out.append(row)
                        pc.executemany(insert, out)
                        copied += len(rows)
                log(f"Copied {table.name}: {copied} rows")

            # ── Move id sequences past the copied ids ──
            for table in tables:
                if "id" in table.columns and table.columns["id"].autoincrement is not False \
                        and table.columns["id"].primary_key:
                    pg.execute(
                        f"SELECT setval(pg_get_serial_sequence('{table.name}', 'id'), "
                        f'COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM "{table.name}"'
                    )

        # ── Verify every row and every copied column ──
        problems = 0
        for table in tables:
            n_dst = pg.execute(f'SELECT COUNT(*) FROM "{table.name}"').fetchone()[0]
            if not present[table.name]:
                if n_dst:
                    log(f"MISMATCH {table.name}: no source table, {n_dst} target rows")
                    problems += 1
                continue
            cols = [c for c in table.columns if c.name in present[table.name]]
            kinds = [_kind(c) for c in cols]
            pk = ", ".join(f'"{c.name}"' for c in table.primary_key.columns)
            src_names = ", ".join(f'"{c.name}"' for c in cols)
            dst_names = ", ".join(f'"{c.name}"::text' if k == "json" else f'"{c.name}"'
                                  for c, k in zip(cols, kinds))
            n_src = src.execute(f'SELECT COUNT(*) FROM "{table.name}"').fetchone()[0]
            if n_src != n_dst:
                log(f"MISMATCH {table.name}: {n_src} source rows, {n_dst} target rows")
                problems += 1
                continue
            sc = src.execute(f'SELECT {src_names} FROM "{table.name}" ORDER BY {pk}')
            batch = _BATCH.get(table.name, _DEFAULT_BATCH)
            diffs = 0
            with pg.cursor(name=f"verify_{table.name}") as dc:
                dc.itersize = batch
                dc.execute(f'SELECT {dst_names} FROM "{table.name}" ORDER BY {pk}')
                for s_row, d_row in zip(iter(lambda: sc.fetchone(), None), dc):
                    for c, k, s, d in zip(cols, kinds, s_row, d_row):
                        if not _same(k, s, d):
                            diffs += 1
                            if diffs <= 10:
                                log(f"MISMATCH {table.name} row {s_row[0]} column {c.name}")
            problems += diffs
            log(f"Verified {table.name}: {n_dst} rows, {diffs} differences")

    if problems:
        raise MigrationError(f"{problems} difference(s) found")
    log("OK: all rows and columns match.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sqlite", required=True, help="path to linksim.db")
    ap.add_argument("--postgres", required=True, help="PostgreSQL URL (postgresql+psycopg://...)")
    args = ap.parse_args()
    try:
        migrate(args.sqlite, args.postgres)
    except MigrationError as e:
        sys.exit(f"FAILED: {e}")


if __name__ == "__main__":
    main()
