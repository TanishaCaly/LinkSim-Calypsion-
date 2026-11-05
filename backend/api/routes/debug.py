"""Debug endpoints — view log tail and run error messages."""
import os
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.storage.database import get_db
from backend.storage import crud
from backend.api.auth import require_auth

router = APIRouter(prefix="/api/debug", tags=["debug"])

_LOG_PATH = os.path.join(os.environ.get("LINKSIM_DATA_DIR") or os.path.join(os.path.dirname(__file__), "..", "..", ".."),
                         "linksim.log")


@router.get("/log")
def tail_log(lines: int = 200):
    """Return last N lines of linksim.log."""
    path = os.path.abspath(_LOG_PATH)
    if not os.path.exists(path):
        return {"path": path, "lines": [], "note": "Log file not created yet — restart the server."}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.readlines()
    return {"path": path, "total_lines": len(all_lines), "lines": all_lines[-lines:]}


@router.get("/runs/{run_id}")
def run_detail(run_id: int, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    """Return full error_message and result JSON for a run — owned by the caller only."""
    run = crud.get_run(db, run_id)
    if not run or not crud.get_scenario(db, run.scenario_id, user_id=user_id):
        return {"error": "run not found"}
    return {
        "id": run.id,
        "status": run.status,
        "num_replications": run.num_replications,
        "error_message": run.error_message,
        "created_at": str(run.created_at),
        "completed_at": str(run.completed_at) if run.completed_at else None,
        "result_summary": {
            "completed_jobs": (run.result or {}).get("simulation_state", {}).get("completed_jobs"),
            "station_count": len((run.result or {}).get("station_stats", {})),
            "has_completion_log": bool((run.result or {}).get("completion_log")),
        } if run.result else None,
    }


@router.get("/runs")
def list_runs(db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    """List the current user's own runs (most recent 20) with status and brief error."""
    from sqlalchemy import text
    rows = db.execute(text(
        "SELECT r.id, r.scenario_id, r.status, r.num_replications, r.error_message, r.created_at "
        "FROM simulation_runs r JOIN scenarios s ON s.id = r.scenario_id "
        "WHERE s.user_id = :uid ORDER BY r.id DESC LIMIT 20"
    ), {"uid": user_id}).fetchall()
    return [
        {
            "id": r[0], "scenario_id": r[1], "status": r[2],
            "num_replications": r[3],
            "error": (r[4] or "")[:300] if r[4] else None,
            "created_at": r[5],
        }
        for r in rows
    ]
