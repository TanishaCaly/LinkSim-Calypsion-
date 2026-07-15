"""
/api/simulations — trigger runs, poll status, retrieve results, stream progress.
"""
import asyncio
import json
import logging
import traceback

logger = logging.getLogger("linksim.simulations")
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from backend.storage import crud, get_db
from backend.storage.crud import get_station_stats
from backend.api.schemas import RunRequest, RunResponse, RunDetailResponse, StationStatResponse
from backend.engine import ManufacturingSimulation
from backend.engine import progress_store
from backend.parsers.yaml_parser import _coerce_sim_config

router = APIRouter(prefix="/api/simulations", tags=["simulations"])


# ---------------------------------------------------------------------------
# Trigger a run
# ---------------------------------------------------------------------------

@router.post("/{scenario_id}/run", response_model=RunResponse, status_code=status.HTTP_202_ACCEPTED)
def trigger_run(
    scenario_id: int,
    req: RunRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    scenario = crud.get_scenario(db, scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")

    run = crud.create_run(db, scenario_id, num_replications=req.num_replications)
    progress_store.init(run.id)
    background_tasks.add_task(
        _execute_run, run.id, scenario_id, dict(req.sim_config_override)
    )
    return run


# ---------------------------------------------------------------------------
# SSE progress stream
# ---------------------------------------------------------------------------

@router.get("/{run_id}/stream")
async def stream_progress(run_id: int, request: Request, db: Session = Depends(get_db)):
    """
    Server-Sent Events endpoint.
    Streams progress events until the run completes or the client disconnects.
    Each event is a JSON object:
      { type: 'progress'|'done'|'error', pct: 0-100, msg: str, ... }
    """
    async def event_gen():
        offset = 0
        try:
            while True:
                # Client disconnect
                if await request.is_disconnected():
                    break

                events = progress_store.get(run_id, offset)
                for evt in events:
                    yield f"data: {json.dumps(evt)}\n\n"
                    offset += 1

                # Stop once a terminal event is emitted
                if events:
                    last = events[-1]
                    if last.get("type") in ("done", "error"):
                        progress_store.cleanup(run_id)
                        break

                # Poll DB fallback: if run is already complete and store is gone
                if run_id not in progress_store._store:
                    run = crud.get_run(db, run_id)
                    if run and run.status in ("completed", "failed"):
                        payload = {
                            "type": "done" if run.status == "completed" else "error",
                            "pct": 100,
                            "msg": f"Run {run.status}",
                            "completed_jobs": run.completed_jobs,
                        }
                        yield f"data: {json.dumps(payload)}\n\n"
                        break

                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Status + results
# ---------------------------------------------------------------------------

@router.get("/{scenario_id}/runs", response_model=List[RunResponse])
def list_runs(scenario_id: int, db: Session = Depends(get_db)):
    scenario = crud.get_scenario(db, scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return crud.list_runs(db, scenario_id)


@router.get("/runs/{run_id}", response_model=RunDetailResponse)
def get_run(run_id: int, db: Session = Depends(get_db)):
    run = crud.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    station_stats = get_station_stats(db, run_id)
    run_dict = {
        "id": run.id,
        "scenario_id": run.scenario_id,
        "status": run.status,
        "created_at": run.created_at,
        "completed_at": run.completed_at,
        "completed_jobs": run.completed_jobs,
        "in_progress_jobs": run.in_progress_jobs,
        "simulation_time": run.simulation_time,
        "num_replications": run.num_replications,
        "error_message": run.error_message,
        "result": run.result,
        "station_stats": [StationStatResponse.model_validate(s) for s in station_stats],
        # Pre-computed KPIs
        "kpi_throughput": run.kpi_throughput,
        "kpi_avg_utilization": run.kpi_avg_utilization,
        "kpi_peak_utilization": run.kpi_peak_utilization,
        "kpi_bottleneck_station": run.kpi_bottleneck_station,
        "kpi_stations_at_risk": run.kpi_stations_at_risk,
        "kpi_total_failures": run.kpi_total_failures,
        "kpi_avg_rework_pct": run.kpi_avg_rework_pct,
        "kpi_sim_days": run.kpi_sim_days,
    }
    return run_dict


# ---------------------------------------------------------------------------
# Background task
# ---------------------------------------------------------------------------

def _execute_run(run_id: int, scenario_id: int, sim_config_override: dict):
    """Called in a BackgroundTask — must create its own DB session."""
    import time as _time
    from backend.storage.database import SessionLocal
    db = SessionLocal()
    _t_start = _time.time()

    def _push(pct: float, msg: str, **extra):
        progress_store.push(run_id, {"type": "progress", "pct": round(pct * 100, 1), "msg": msg, **extra})
        logger.info(f"[RUN {run_id}] {pct*100:.0f}% — {msg} (elapsed: {_time.time()-_t_start:.1f}s)")

    try:
        logger.info(f"[RUN {run_id}] Starting — scenario_id={scenario_id} overrides={sim_config_override}")

        scenario = crud.get_scenario(db, scenario_id)
        if not scenario:
            logger.error(f"[RUN {run_id}] Scenario {scenario_id} not found")
            progress_store.push(run_id, {"type": "error", "pct": 0, "msg": "Scenario not found"})
            crud.fail_run(db, run_id, "Scenario not found")
            return

        crud.mark_run_running(db, run_id)
        _push(0, "Initialising simulation…")

        # Merge sim config: scenario base → override from run request
        base_cfg = _coerce_sim_config(scenario.simulation_config or {})
        if sim_config_override:
            base_cfg.update({
                k: float(v) if isinstance(v, (int, float)) else v
                for k, v in sim_config_override.items()
            })
        logger.info(f"[RUN {run_id}] Effective sim_config: {base_cfg}")

        # ── Diagnostic: log resource-name mismatches ──
        stations_keys = set((scenario.stations_data or {}).keys())
        station_lower = {k.lower().strip(): k for k in stations_keys}
        pf = scenario.processflow_data or {}
        logger.info(f"[RUN {run_id}] Stations ({len(stations_keys)}): {sorted(stations_keys)}")
        logger.info(f"[RUN {run_id}] Variants: {list(pf.keys())}")
        total_jobs = sum(scenario.variant_quantities.values()) if scenario.variant_quantities else 0
        logger.info(f"[RUN {run_id}] Variant quantities: {scenario.variant_quantities} → TOTAL JOBS: {total_jobs}")

        sim = ManufacturingSimulation(
            stations_data=scenario.stations_data,
            processflow_data=scenario.processflow_data,
            variant_quantities=scenario.variant_quantities,
            operators_data=scenario.operators_data,
            simulation_config=base_cfg,
            progress_callback=_push,
            variant_intervals=scenario.variant_intervals,
            setup_matrix=scenario.setup_matrix,
        )

        run_record = crud.get_run(db, run_id)
        num_reps = run_record.num_replications if run_record else 1
        logger.info(f"[RUN {run_id}] Running {num_reps} replication(s)… (elapsed so far: {_time.time()-_t_start:.1f}s)")

        _t_sim = _time.time()
        if num_reps > 1:
            result = sim.run_with_replications(num_replications=num_reps)
        else:
            result = sim.run()
        _t_sim_done = _time.time()

        completed = result.get("simulation_state", {}).get("completed_jobs", 0)
        logger.info(f"[RUN {run_id}] sim.run() took {_t_sim_done-_t_sim:.2f}s | completed_jobs={completed}")
        logger.info(f"[RUN {run_id}] saving to DB… (elapsed: {_time.time()-_t_start:.1f}s)")
        for sname, ss in result.get("station_stats", {}).items():
            logger.info(f"[RUN {run_id}]   {sname}: jobs={ss.get('completed_jobs',0)}, util={ss.get('station_utilization',0):.1f}%")

        crud.complete_run(db, run_id, result)
        progress_store.push(run_id, {
            "type": "done",
            "pct": 100,
            "msg": "Simulation complete",
            "completed_jobs": completed,
        })

    except Exception as exc:
        tb = traceback.format_exc()
        logger.error(f"[RUN {run_id}] FAILED: {exc}\n{tb}")
        crud.fail_run(db, run_id, f"{exc}\n{tb}")
        progress_store.push(run_id, {"type": "error", "pct": 100, "msg": str(exc)})
    finally:
        db.close()
