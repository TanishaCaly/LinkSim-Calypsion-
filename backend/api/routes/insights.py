"""
/api/insights — AI-powered recommendations for a completed run.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.storage import crud, get_db
from backend.api.auth import require_auth
from backend.engine.ai_insights import ai_insights_engine
from backend.api.schemas import InsightsResponse
from backend.api.routes.license import require_feature
from backend import licensing

router = APIRouter(prefix="/api/insights", tags=["insights"],
                   dependencies=[Depends(require_feature(licensing.INSIGHTS_AI))])


@router.get("/{run_id}", response_model=InsightsResponse)
def get_insights(run_id: int, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    run = crud.get_run(db, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    scenario = crud.get_scenario(db, run.scenario_id, user_id=user_id)
    if not scenario:
        raise HTTPException(404, "Run not found")
    if run.status != "completed":
        raise HTTPException(400, f"Run is not completed yet (status: {run.status})")
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
