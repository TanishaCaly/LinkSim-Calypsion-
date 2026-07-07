"""
/api/upload — parse uploaded files and optionally create a scenario.
Supports: .yaml, .xlsx, individual CSV bundle, or single flat routing CSV.
"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from typing import Optional, Dict, Any

from backend.parsers import ParserFactory, CsvParser
from backend.api.schemas import UploadResponse

router = APIRouter(prefix="/api/upload", tags=["upload"])

_SUPPORTED = {".yaml", ".yml", ".xlsx", ".xls", ".csv"}
_csv = CsvParser()


def _validate_parsed(parsed: Dict[str, Any]) -> None:
    """
    Only reject a file when NOTHING at all was recognized (every section came
    back empty) — that's the "wrong file / totally unreadable" case. Partial
    imports (e.g. a stations-only sheet with no process flow yet) are valid
    and intentionally allowed through; don't require all four sections.
    """
    sections = ("stations", "operators", "processflow", "variant_quantities")
    if not any(parsed.get(s) for s in sections):
        raise ValueError(
            "No usable data was found in this file (stations, operators, process flow, and "
            "variant quantities all came back empty). Check that column headers are on the "
            "first row of the sheet and match the expected names."
        )


@router.post("/scenario", response_model=UploadResponse)
async def upload_scenario(file: UploadFile = File(...)):
    """
    Upload a single .yaml or .xlsx file containing the full scenario.
    Returns parsed data for preview before saving as a Scenario.
    """
    ext = _file_ext(file.filename)
    if ext not in _SUPPORTED:
        raise HTTPException(400, f"Unsupported file type: {ext}. Use .yaml or .xlsx")
    if ext == ".csv":
        raise HTTPException(400, "For CSV upload, use /api/upload/csv-bundle with 4 files.")

    content = await file.read()
    try:
        parsed = ParserFactory.parse_all(content, filename=file.filename)
        _validate_parsed(parsed)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    return UploadResponse(**parsed)


@router.post("/csv-bundle", response_model=UploadResponse)
async def upload_csv_bundle(
    stations: UploadFile = File(...),
    operators: UploadFile = File(...),
    processflow: UploadFile = File(...),
    quantities: UploadFile = File(...),
):
    """Upload four separate CSV files (stations, operators, processflow, quantities)."""
    try:
        parsed = ParserFactory.parse_csv_bundle(
            stations=await stations.read(),
            operators=await operators.read(),
            processflow=await processflow.read(),
            quantities=await quantities.read(),
        )
        _validate_parsed(parsed)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    return UploadResponse(**parsed)


@router.post("/flat-csv", response_model=UploadResponse)
async def upload_flat_csv(file: UploadFile = File(...)):
    """
    Upload a single flat process-routing CSV with columns:
      Part_Name | Part_Number | Annual_Volume | Process_Name | Machine | Cycle_Time

    Stations and quantities are auto-derived from the data.
    """
    ext = _file_ext(file.filename)
    if ext != ".csv":
        raise HTTPException(400, "flat-csv endpoint only accepts .csv files.")

    content = await file.read()
    try:
        parsed = ParserFactory.parse_flat_csv(content)
        _validate_parsed(parsed)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    return UploadResponse(**parsed)


def _file_ext(filename: Optional[str]) -> str:
    if not filename:
        return ""
    import os
    _, ext = os.path.splitext(filename.lower())
    return ext
