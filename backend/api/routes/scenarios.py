"""
/api/scenarios — CRUD for simulation scenarios.
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from backend.storage import crud, get_db
from backend.api.auth import require_auth
from backend.api.routes.license import check_scenario_limit, check_station_limit, current_license
from backend.api.schemas import (
    ScenarioCreate, ScenarioUpdate, ScenarioResponse, ScenarioListItem
)

router = APIRouter(prefix="/api/scenarios", tags=["scenarios"])


@router.post("/", response_model=ScenarioResponse, status_code=status.HTTP_201_CREATED)
def create_scenario(payload: ScenarioCreate, db: Session = Depends(get_db), user_id: int = Depends(require_auth),
                    license=Depends(current_license)):
    check_scenario_limit(license, crud.count_scenarios(db, user_id=user_id))
    check_station_limit(license, payload.stations_data)
    return crud.create_scenario(db, payload.model_dump(), user_id=user_id)


@router.get("/", response_model=List[ScenarioListItem])
def list_scenarios(skip: int = 0, limit: int = 50, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    return crud.list_scenarios(db, skip=skip, limit=limit, user_id=user_id)


@router.get("/count")
def count_scenarios(db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    return {"count": crud.count_scenarios(db, user_id=user_id)}


@router.get("/{scenario_id}", response_model=ScenarioResponse)
def get_scenario(scenario_id: int, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    scenario = crud.get_scenario(db, scenario_id, user_id=user_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return scenario


@router.patch("/{scenario_id}", response_model=ScenarioResponse)
def update_scenario(scenario_id: int, payload: ScenarioUpdate, db: Session = Depends(get_db), user_id: int = Depends(require_auth),
                    license=Depends(current_license)):
    if payload.stations_data is not None:
        check_station_limit(license, payload.stations_data)
    updated = crud.update_scenario(db, scenario_id, payload.model_dump(exclude_none=True), user_id=user_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return updated


@router.delete("/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_scenario(scenario_id: int, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    if not crud.delete_scenario(db, scenario_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Scenario not found")


@router.get("/{scenario_id}/file")
def download_scenario_file(scenario_id: int, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    scenario = crud.get_scenario(db, scenario_id, user_id=user_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    if not scenario.source_file or not scenario.source_filename:
        raise HTTPException(status_code=404, detail="No source file stored for this scenario")
    import mimetypes
    mime, _ = mimetypes.guess_type(scenario.source_filename)
    mime = mime or "application/octet-stream"
    return Response(
        content=scenario.source_file,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{scenario.source_filename}"'},
    )


@router.get("/{scenario_id}/validate")
def validate_scenario(scenario_id: int, db: Session = Depends(get_db), user_id: int = Depends(require_auth)):
    """Check for resource/station name mismatches in processflow data."""
    scenario = crud.get_scenario(db, scenario_id, user_id=user_id)
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found")
    # Scenario inputs are stored as separate columns, not a single
    # `scenario_config` blob — read them directly.
    stations_data = scenario.stations_data or {}
    pf = scenario.processflow_data or {}
    station_keys = set(stations_data.keys())
    station_lower = {k.lower().strip(): k for k in station_keys}

    issues = []
    for variant, steps in pf.items():
        for step in (steps or []):
            raw = step.get("resource", "")
            # Older scenarios (saved while the Exit Controller existed) may hold
            # {"mode", "options": [station, ...]} instead of one station name:
            # each option is checked like a name.
            names = (raw.get("options") or []) if isinstance(raw, dict) else [raw]
            for name in names:
                name = name if isinstance(name, str) else str(name or "")
                if name in station_keys:
                    continue
                resolved = station_lower.get(name.lower().strip())
                issues.append({
                    "variant": variant,
                    "operation": step.get("operation"),
                    "resource": name,
                    "resolved_to": resolved,
                    "type": "case_mismatch" if resolved else "missing",
                })

    return {
        "scenario_id": scenario_id,
        "station_count": len(station_keys),
        "station_names": sorted(station_keys),
        "variant_count": len(pf),
        "variants": list(pf.keys()),
        "variant_quantities": scenario.variant_quantities or {},
        "sim_config": scenario.simulation_config or {},
        "issues": issues,
        "issue_count": len(issues),
    }
