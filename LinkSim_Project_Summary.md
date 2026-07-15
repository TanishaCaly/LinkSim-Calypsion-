# LinkSim — Project Summary

LinkSim is a manufacturing discrete-event simulation (DES) tool. A user imports real factory data (stations, operators, process routing, product volumes), builds/reviews the process flow visually, runs a simulation, and gets back KPIs, charts, a Gantt timeline, and rule-based insights — exportable as a PDF report.

Stack: **FastAPI + SimPy + SQLite** backend, **React/TypeScript + ReactFlow + Recharts** frontend.

---

## 1. Import

A scenario can be created from three input formats:

| Format | Entry point | Notes |
|---|---|---|
| YAML or Excel (single file) | `POST /api/upload/scenario` → `ParserFactory.parse_all()` | Auto-detects `.yaml`/`.xlsx` by extension, or sniffs YAML by content (`---`, `scenario:` keys) |
| 4-file CSV bundle | `POST /api/upload/csv-bundle` | Separate Stations / Operators / ProcessFlow / VariantQuantities CSVs |
| Single flat CSV | `POST /api/upload/flat-csv` | One routing sheet: `Part_Name, Part_Number, Annual_Volume, Process_Name, Machine, Cycle_Time` — stations and quantities are auto-derived from it |

Every import format normalizes down to the same **4 data sections**: `stations`, `operators`, `processflow`, `variant_quantities`.

**Robustness built into the parsers** (this is the part that makes it usable with real, messy company spreadsheets, not just clean demo files):
- Auto-detects the real header row in an Excel sheet even if there's a title/blank row above it (`_promote_header_row`, scans first 10 rows for keyword hits).
- Can find a second embedded mini-table further down a sheet (`_find_subtable`).
- Fuzzy column matching — e.g. "Capacity (machines)" still matches "capacity" (`_find_col`, case-insensitive substring).
- Blank cells and trailing empty rows don't crash the import — they're safely defaulted (`_clean_str`, `_safe_int`, `_safe_float`, `_is_blank_row`).
- **Partial imports are explicitly allowed**: a file is only rejected if *all four* sections come back empty. If a company sends stations-only data, it still imports.
- Flat-CSV volume conversion: `Annual_Volume / WORKING_DAYS_PER_YEAR(250)`, ceiling-rounded, minimum 1/day — a real unit-conversion policy, not a guess.

## 2. Scenario storage

Once parsed, the data is saved via `POST /api/scenarios/` into a `Scenario` DB row containing:
- `stations_data`, `processflow_data`, `variant_quantities`, `operators_data`, `simulation_config` — all stored as JSON columns.
- `source_filename` + `source_file` (raw bytes) — **the original uploaded file is kept**, downloadable again later via `GET /{id}/file`.
- A `GET /{id}/validate` endpoint independently cross-checks the process flow against the station list, flagging references that don't exist or only match by different case — catches data errors before a sim ever runs.

Full CRUD exists (list/get/update/delete) plus scenario listing is paginated.

## 3. Visual Canvas

One page, two modes:

- **View mode** — read-only. Builds a ReactFlow graph directly from the saved process flow. A station with `capacity > 1` is automatically fanned out into labeled boxes (`Operation #1`, `#2`, ...) stacked vertically, each fully cross-connected to the next stage's boxes — this is how "2 parallel machines" gets visualized.
- **Build mode** — a fully interactive drag-and-drop-style graph editor (click-to-add palette, not native HTML5 drag/drop). Users can add stations, wire connections, and "Add parallel machine" to clone a box and auto-renumber/rewire it.

**Save compiles the graph back into a scenario**: it groups boxes by base station name (how many share a name = that station's `capacity`), walks the graph breadth-first from entry nodes to build one linear process-flow step list, and submits a complete `ScenarioCreate` payload (with sensible defaults for operator/shift config) via the API.

## 4. Simulation engine

Core class: `ManufacturingSimulation` (`backend/engine/sim_core.py`), wrapping a `simpy.Environment`.

**Flow**: validate config → reset state → run → post-process → collect results.

- **Guardrails**: rejects non-finite/non-positive `SIM_TIME`; clamps any request over 1 simulated year so a run can never effectively hang forever.
- **Job spawning**: one SimPy process per job, per variant, per quantity — `env.process(...)` for every unit to be produced.
- **Per-station processing loop** (`_perform_operation`) is the heart of the engine. For every job arriving at a station, in order:
  1. Requests the station's `Machine` resource (a SimPy `Resource` sized by `capacity`) — waits if all slots are busy (blocked time).
  2. Enters a **shift-aware loop**: only processes during the station's active shift window (global default or a per-station override); 1- and 2-shift stations are Mon-Fri only, 0- or 3-shift stations run 24/7.
  3. Inside a shift window, in order: handles machine downtime (failure/PM), checks operator availability (skips gating entirely if the station has 0 assigned operators — a machine-only station), checks material-shortage probability, then processes a time chunk.
  4. If the simulation horizon ends mid-job, the partial progress is recorded but the job is **not** falsely counted as completed.
  5. After processing, checks for rework (probability-based, specifically detects "inspector/tester/qa" roles in the assigned operator) and processes it in its own shift-respecting loop.
  6. On completion: records busy time, operator busy time, and a detailed completion-log entry (12+ fields: blocked/waiting/processing/downtime/pause/rework time, plus percentage breakdowns of each).

**Machine failure & preventive maintenance** (`backend/engine/machine.py`): each station's `Machine` runs two independent stochastic/scheduled processes — random failures (exponential time-to-failure derived from a configured daily failure probability) and scheduled PM (Monthly/Bi-Weekly/Weekly), mutex-guarded so they can't overlap, with full structured downtime event logging.

**Statistical replications**: `run_with_replications(num_replications=5)` runs the whole simulation N times with different random seeds, then averages every station's stats and computes **real 95% confidence intervals** (t-distribution, via scipy) — mean, lower/upper bound, standard deviation. Bottleneck classifications across replications are aggregated by majority vote.

## 5. Results / KPIs

`backend/engine/formulas.py` is the single source of truth for every metric — every other module imports from it, so there's exactly one formula per KPI, not scattered duplicate logic.

- **Station utilization** = busy time ÷ available time, where available time correctly accounts for shift length, shifts/day, *working days* (weekday-only for 1-2 shift stations, 24/7 for 0/3-shift stations), and station capacity.
- **Operator utilization** = same idea, but available time is sized by `operator_per_station × capacity` — because each parallel machine slot has its own operator crew.
- **Rework** is tracked two distinct ways: rework rate (% of jobs needing rework — a unit-count, Six Sigma-style metric) and rework time ratio (% of busy time spent on rework — a capacity-planning metric). These answer different questions and are kept separate on purpose.
- **Bottleneck detection**: named thresholds — 80% utilization = "at risk," 85% = "bottleneck." `identify_bottlenecks()` produces up to 3 prioritized, ranked issues per station (failure rate, operator skill, operator availability, station capacity, operator count), each with an estimated parts-gain if fixed — not just a flag, an actual recommendation with a number attached.
- Throughput, peak/average utilization, stations-at-risk count, total failures, and average rework % are all rolled up into one `build_summary()` call per run.

## 6. Live progress streaming

A genuine real-time feature, not a polling hack from the frontend alone:

- The simulation runs in a background thread; a thread-safe in-memory store (`progress_store.py`) buffers progress events per run.
- The frontend opens a **Server-Sent Events (SSE)** connection (`GET /{run_id}/stream`); the backend polls its own buffer every 0.25s and streams new events as they land.
- Handles reconnects (falls back to polling the DB run status if the in-memory buffer already expired) and client disconnects cleanly.

## 7. AI Insights

**Fully rule-based — there is no LLM call anywhere in this feature.** `AIInsightsEngine` produces 7 categories of insight (strategic recommendations, operational insights, predictive analysis, optimization opportunities, risk assessment, performance trends, and an overall AI confidence score), each generated from deterministic thresholds and formulas over the simulation's real output — e.g. "system-wide capacity constraint" fires when over 60% of stations exceed 85% utilization; a "single point of failure" risk fires when one operator is assigned to more than 2 high-utilization stations. The confidence score itself is a weighted composite (30% data completeness + 30% consistency + 20% sample size + 20% baseline), not a black-box number.

This is worth being upfront about internally: it's a legitimate, well-engineered rules engine that gives genuinely useful, explainable output — but it should not be described as "AI" in the machine-learning sense to stakeholders expecting an LLM behind it.

## 8. Run Dashboard (frontend)

Two tabs:
- **KPIs tab** — two rows of KPI tiles (completed jobs, throughput, sim duration, peak utilization, average utilization, bottleneck station, stations at risk, total failures/rework), a color-coded Station Health Overview grid (green/amber/red by utilization band) with hover detail popups, and utilization bar charts (station vs. operator, per station).
- **Gantt tab** — a full timeline view built from the completion log, with expand/collapse and hover tooltips per job.

A live progress card appears automatically while a run is executing, fed by the SSE stream described above.

## 9. PDF Export

This is **browser print-to-PDF, not server-side PDF generation** — there is no PDF library anywhere in the codebase. The "Export PDF" button calls the browser's native `window.print()`. Dedicated print CSS hides all interactive chrome (sidebar, buttons, toasts) and forces the content to lay out at full height instead of being clipped to the viewport, so what prints is just the KPI/chart/Gantt report content. It's a lightweight, dependency-free approach, but worth knowing it depends on the browser's print dialog rather than producing a file server-side.

---

## Summary for your senior

**End-to-end flow:** Excel/CSV/YAML file → parsed & normalized into 4 standard sections → saved as a Scenario → reviewed/edited on a visual canvas (with automatic parallel-machine visualization) → run through a real SimPy discrete-event simulation (shift-aware, operator-aware, with stochastic failures/PM/rework/material shortages) → optionally repeated across N replications with statistical confidence intervals → results computed through one centralized formulas module → streamed live to the frontend via SSE while running → displayed as KPIs/charts/Gantt → summarized by a rule-based insights engine → exportable as a PDF via the browser's print function.

**Two things worth flagging plainly to leadership:**
1. **"AI Insights" is a rules engine, not machine learning** — real, useful, explainable, but not an LLM.
2. **PDF export is browser print, not a generated file** — fine for now, but a real constraint if server-side or emailed reports are ever needed.
