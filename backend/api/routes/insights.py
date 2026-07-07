"""
/api/insights — AI-powered recommendations for a completed run.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.storage import crud, get_db
from backend.engine.ai_insights import ai_insights_engine
from backend.api.schemas import InsightsResponse

router = APIRouter(prefix="/api/insights", tags=["insights"])


@router.get("/{run_id}", response_model=InsightsResponse)
def get_insights(run_id: int, db: Session = Depends(get_db)):
    run = crud.get_run(db, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    if run.status != "completed":
        raise HTTPException(400, f"Run is not completed yet (status: {run.status})")

    scenario = crud.get_scenario(db, run.scenario_id)
    result = run.result or {}

    insights = ai_insights_engine.generate_insights(
        stations_data={
            name: {**scenario.stations_data.get(name, {}), **stats}
            for name, stats in result.get("station_stats", {}).items()
        },
        simulation_config=scenario.simulation_config,
        operators_data=scenario.operators_data,
        bottleneck_data=result.get("bottleneck_store", {}),
    )

    return InsightsResponse(run_id=run_id, insights=insights)
