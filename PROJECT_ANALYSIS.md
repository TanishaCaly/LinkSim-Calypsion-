# LinkSim — Complete Codebase Analysis

## 1. Project Overview

**What problem does it solve?**
LinkSim is a **Manufacturing Discrete Event Simulation (DES)** tool. It lets manufacturing engineers define factory production lines (stations, operators, process flows) and run simulations to predict throughput, utilization, bottlenecks, and failure impact — without touching the real factory floor.

**Main purpose:** Build, simulate, and analyze manufacturing lines to optimize production.

**Users:** Manufacturing engineers, industrial engineers, production planners.

**Major features:**
- Upload scenario data from YAML, Excel, or CSV files
- Visual canvas (drag-and-drop) to build process flows
- Run discrete-event simulations with SimPy (single or multi-replication with 95% confidence intervals)
- Real-time progress streaming via SSE
- KPI dashboard (throughput, utilization, bottleneck, failures, rework)
- AI-powered insights engine (strategic, operational, predictive, risk)
- Dark/light theme

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| **Backend language** | Python 3.12 |
| **Web framework** | FastAPI 0.115 |
| **ASGI server** | Uvicorn 0.30.6 |
| **Simulation engine** | SimPy 4.1.1 |
| **ORM** | SQLAlchemy 2.0.35 |
| **Database** | PostgreSQL |
| **Data processing** | Pandas 2.2.3, NumPy 1.26.4 |
| **Statistics** | SciPy 1.14.1 |
| **File parsing** | PyYAML 6.0.2, openpyxl 3.1.5 |
| **Validation** | Pydantic 2.9.2 |
| **Frontend language** | TypeScript 6.0 |
| **UI framework** | React 19.2 |
| **Build tool** | Vite 8.0 |
| **CSS** | Tailwind CSS 4.0 |
| **State management** | Zustand 5.0 |
| **Data fetching** | TanStack React Query 5.60, Axios 1.7.7 |
| **UI components** | Radix UI (dialog, tabs, select, toast, etc.), Lucide React icons |
| **Charts** | Recharts 2.13 |
| **Visual canvas** | ReactFlow 11.11 |
| **Testing** | Pytest 8.3.3, httpx 0.27.2, pytest-asyncio |

---

## 3. Folder Structure

```
LinkSim-Main/
├── main.py                          # Backend entry point (FastAPI app)
├── requirements.txt                 # Python dependencies
├── tshirt_factory.yaml              # Example scenario (T-shirt manufacturing)
├── linksim.log                      # Application log file
│
├── backend/
│   ├── api/                         # HTTP layer
│   │   ├── schemas.py               # Pydantic request/response models
│   │   └── routes/
│   │       ├── __init__.py          # Exports all routers
│   │       ├── scenarios.py         # CRUD for scenarios (/api/scenarios)
│   │       ├── simulations.py       # Trigger runs, SSE streaming, results
│   │       ├── upload.py            # File upload & parsing endpoints
│   │       ├── insights.py          # AI insights endpoint
│   │       └── debug.py             # Debug/log endpoints
│   │
│   ├── engine/                      # Core simulation logic
│   │   ├── sim_core.py             # ManufacturingSimulation class (main engine)
│   │   ├── machine.py              # Machine resource (SimPy Resource with failure/PM)
│   │   ├── components.py           # DES primitives (Generator, Queue, Activity, Entity)
│   │   ├── formulas.py             # All KPI formulas (single source of truth)
│   │   ├── sim_utils.py            # Shift, operator, material helpers
│   │   ├── bottleneck.py           # Bottleneck identification & analysis
│   │   ├── ai_insights.py          # AI insights engine
│   │   └── progress_store.py       # Thread-safe SSE progress events
│   │
│   ├── parsers/                     # File format parsers
│   │   ├── factory.py              # ParserFactory (dispatches by extension)
│   │   ├── yaml_parser.py          # YAML scenario parser
│   │   ├── excel_parser.py         # Excel (.xlsx) parser
│   │   ├── csv_parser.py           # CSV parser (stations, operators, etc.)
│   │   └── flat_csv_parser.py      # Flat process-routing CSV parser
│   │
│   ├── storage/                     # Database layer
│   │   ├── database.py             # Engine, session factory, get_db dependency
│   │   ├── models.py               # SQLAlchemy ORM models
│   │   └── crud.py                 # CRUD operations
│   │
│   └── tests/
│       └── test_smoke.py           # Smoke/regression tests
│
└── frontend/                        # React SPA
    ├── package.json                # Node dependencies
    ├── vite.config.ts              # Vite config with API proxy
    ├── index.html                  # HTML shell
    └── src/
        ├── main.tsx                # React entry point
        ├── App.tsx                 # Router + providers
        ├── api/
        │   ├── client.ts           # Axios instance with error interceptor
        │   ├── scenarios.ts        # Scenario API calls
        │   ├── simulations.ts      # Simulation API calls
        │   └── insights.ts         # Insights API calls
        ├── store/
        │   └── useAppStore.ts      # Zustand global state
        ├── types/
        │   └── index.ts            # TypeScript interfaces
        ├── lib/
        │   └── utils.ts            # cn(), formatDate(), priorityColor()
        ├── pages/
        │   ├── ScenarioManager.tsx  # Scenario list, import, view modal
        │   ├── RunDashboard.tsx     # Run trigger, KPI cards, charts
        │   ├── Canvas.tsx           # Visual flow builder (ReactFlow)
        │   └── Insights.tsx         # AI insights display
        └── components/
            ├── layout/
            │   └── Layout.tsx       # Sidebar nav + toast
            └── ui/                  # shadcn-style Radix components
                ├── badge.tsx, button.tsx, card.tsx,
                ├── dialog.tsx, input.tsx, label.tsx, progress.tsx
```

---

## 4. Entry Point

### Backend: `main.py`

Execution starts with `uvicorn main:app --reload --port 8000`.

**Startup sequence:**
1. **Lines 14-24:** Configures logging to `linksim.log` + console
2. **Line 27:** Imports `init_db` from `backend.storage.database`
3. **Lines 28-34:** Imports all route routers
4. **Lines 37-41:** `lifespan()` context manager calls `init_db()` on startup (creates tables idempotently)
5. **Lines 44-49:** Creates FastAPI app with title, description, version, and lifespan
6. **Lines 55-71:** Configures CORS middleware (allows local dev origins)
7. **Lines 74-78:** Registers 5 routers (scenarios, simulations, upload, insights, debug)
8. **Lines 81-83:** Health check endpoint at `/health`

### Frontend: `src/main.tsx`

1. Mounts `<App />` into `#root`
2. `App.tsx` sets up `QueryClientProvider` (React Query), `BrowserRouter`, and 4 routes inside a shared `Layout`

---

## 5. Architecture

**Overall architecture:** Client-server with REST API backend and SPA frontend.

**Design pattern:** Layered architecture with clear separation:

```
+---------------------------------------------------+
|                  FRONTEND (React)                   |
|  Pages -> API clients -> React Query -> Axios       |
+----------------------+------------------------------+
                       | HTTP / SSE
+----------------------+------------------------------+
|                  API LAYER (FastAPI)                 |
|  Routes -> Pydantic Schemas -> CRUD helpers         |
+----------------------+------------------------------+
                       |
+----------------------+------------------------------+
|                ENGINE LAYER                          |
|  ManufacturingSimulation -> Machine -> SimPy        |
|  Bottleneck -> AI Insights -> Formulas              |
+----------------------+------------------------------+
                       |
+----------------------+------------------------------+
|               STORAGE LAYER                          |
|  SQLAlchemy ORM -> PostgreSQL                        |
+----------------------------------------------------+
```

**Dependency flow:** Routes depend on CRUD, CRUD depends on Models, Engine is independent of the API layer (clean separation — engine was ported from Dash/Streamlit apps).

---

## 6. Request Flow

**Example: Running a simulation**

```
User clicks "Run" on frontend
  -> simulationsApi.triggerRun(scenarioId, overrides)
  -> POST /api/simulations/{id}/run  (RunRequest body)
  -> simulations.py trigger_run()
  -> crud.create_run() -> DB (status=pending)
  -> progress_store.init(run_id)
  -> BackgroundTasks.add_task(_execute_run, ...)
  -> Returns HTTP 202 with RunResponse immediately

Background thread (_execute_run):
  -> crud.mark_run_running()
  -> Creates ManufacturingSimulation with scenario data
  -> sim.run() or sim.run_with_replications()
  -> Progress callbacks -> progress_store.push()
  -> crud.complete_run() -> saves results + KPIs + StationStat rows
  -> progress_store.push({type: "done"})

Frontend polls via SSE:
  -> GET /api/simulations/{run_id}/stream
  -> StreamingResponse with Server-Sent Events
  -> Reads progress_store.get(run_id, offset)
  -> Emits JSON events until "done" or "error"
  -> Frontend renders KPI cards, charts, etc.
```

---

## 7. Module-by-Module Explanation

### 7.1 API Routes (`backend/api/routes/`)

**Purpose:** HTTP endpoints that connect frontend to business logic.

| File | Routes | Purpose |
|---|---|---|
| `scenarios.py` | `POST/GET/PATCH/DELETE /api/scenarios/`, `GET /{id}/file`, `GET /{id}/validate` | Full CRUD + file download + validation |
| `simulations.py` | `POST /{id}/run`, `GET /{id}/stream` (SSE), `GET /{id}/runs`, `GET /runs/{id}` | Trigger, stream progress, list/get results |
| `upload.py` | `POST /api/upload/scenario`, `/csv-bundle`, `/flat-csv` | Parse files without saving |
| `insights.py` | `GET /api/insights/{run_id}` | Generate AI insights for completed run |
| `debug.py` | `GET /api/debug/log`, `/runs/{id}`, `/runs` | Log tail, run debugging |

### 7.2 Parsers (`backend/parsers/`)

**Purpose:** Convert uploaded files (YAML, Excel, CSV) into the dict structures that `ManufacturingSimulation` expects.

**Key pattern — Factory:**
- `ParserFactory.parse_all(content, filename)` -> dispatches to `YamlParser` or `ExcelParser` based on file extension
- `ParserFactory.parse_csv_bundle(stations, operators, processflow, quantities)` -> delegates to `CsvParser`
- `ParserFactory.parse_flat_csv(content)` -> delegates to `FlatCsvParser`

**All parsers return the same shape:**
```python
{
    "stations": Dict[str, StationConfig],
    "operators": Dict[str, OperatorConfig],
    "processflow": Dict[str, List[ProcessStep]],
    "variant_quantities": Dict[str, int],
    "simulation_config": Dict (optional, YAML only)
}
```

**Notable:** `ExcelParser` has intelligent header detection — it scans the first 10 rows looking for keyword matches to find the real header row (handles title rows, spacer rows, etc.).

### 7.3 Engine (`backend/engine/`)

#### `sim_core.py` — ManufacturingSimulation (core file, 882 lines)

**Purpose:** The simulation engine. Creates SimPy processes for each job, routes them through stations, handles shift scheduling, failures, operator availability, material shortages, and rework.

**Key methods:**
- `run()` -> validate -> reset -> simpy -> post-process -> collect results
- `run_with_replications(n)` -> runs N seeds, aggregates with 95% CI
- `_process_variant(id, type)` -> SimPy generator: iterates through process steps
- `_perform_operation(...)` -> Core logic: request machine -> wait for shifts -> handle downtime -> process chunks -> handle rework

**Design:** Jobs are SimPy processes. Each station is a `Machine` (SimPy `Resource` with capacity). Jobs yield on `resource.request()`, then process in shift-aware chunks.

#### `machine.py` — Machine (156 lines)

Extends `simpy.Resource`. Two background SimPy processes run for each machine:
- `_run_failure_cycle()` — stochastic failures (exponential distribution)
- `_run_preventive_maintenance()` — scheduled PM (Monthly/Weekly/Bi-Weekly)

Uses a mutex to prevent simultaneous failure + PM. Tracks `working` state and `working_event` for other processes to wait on.

#### `formulas.py` (288 lines)

**Single source of truth for all KPI calculations.** Every metric (utilization, rework %, throughput, risk scores, etc.) is a pure function here. All other modules import from this file.

Key thresholds: `AT_RISK_UTILIZATION = 80%`, `BOTTLENECK_UTILIZATION = 85%`.

#### `bottleneck.py` (296 lines)

Analyzes each station and returns up to 3 prioritized bottleneck records with:
- Type (failure_rate, operator_skill, operator_availability, station_capacity, operator_count)
- Recommendation
- Estimated gain (parts)
- Difficulty rating

#### `ai_insights.py` (333 lines)

Generates 5 categories of insights:
1. **Strategic** — system-wide constraints, workforce development
2. **Operational** — workload imbalance, shift performance variance
3. **Predictive** — maintenance alerts, capacity planning
4. **Optimization** — cross-station load balancing, parallel processing
5. **Risk** — single point of failure operators, equipment risk

Also calculates an `ai_confidence` score (0-95%) based on data completeness, consistency, and sample size.

#### `progress_store.py` (41 lines)

Thread-safe in-memory store for SSE progress events. Simulation runs in a `BackgroundTask` thread and pushes events; the SSE endpoint polls without blocking.

### 7.4 Storage (`backend/storage/`)

#### `database.py`

Creates SQLAlchemy engine + session factory on PostgreSQL, from the `DATABASE_URL` env var (required — the backend stops with a message without it). `get_db()` is a FastAPI dependency that yields and closes a session.

#### `models.py`

Three tables:
- `scenarios` — stores uploaded scenario data as JSON blobs
- `simulation_runs` — one row per execution, stores status, KPIs, full result JSON
- `station_stats` — denormalized per-station rows for fast frontend queries

Relationships: `Scenario 1:N SimulationRun 1:N StationStat`

#### `crud.py`

Pure CRUD helpers. `complete_run()` is the most complex — it extracts KPIs from the simulation result and creates `StationStat` rows.

### 7.5 Frontend

#### `ScenarioManager.tsx` (main page)

Landing page. Shows scenario cards in a grid. Import dialog supports 3 modes: YAML/XLSX, Flat CSV, 4-CSV bundle. Clicking a scenario navigates to `/run`.

#### `RunDashboard.tsx` (largest file)

KPI dashboard with 7 clickable cards, each opening a modal with detailed station breakdowns:
- Completed Jobs, Peak Utilization, Avg Station Utilization
- Bottleneck Station, Throughput, Stations at Risk, Total Failures, Sim Duration

Has a `SimConfigDialog` for setting SIM_TIME and replications (with presets: 1 shift, 1 day, 1 week, 1 month, 1 year).

#### `Canvas.tsx` (857 lines)

Two modes:
- **View mode:** Renders process flow as a ReactFlow graph with utilization color overlay
- **Build mode:** Free-form drag-and-drop station builder. Stations with capacity >1 show as parallel boxes. Saves to scenario via API.

#### `Insights.tsx`

Displays AI insights in categorized sections with priority badges, confidence scores, and recommendation cards.

---

## 8. Important Files

| File | Why it matters |
|---|---|
| ⭐ `main.py` | Backend entry point, app configuration |
| ⭐ `backend/engine/sim_core.py` | Core simulation logic (882 lines) |
| ⭐ `backend/engine/formulas.py` | All KPI formulas — change anything here |
| ⭐ `backend/engine/machine.py` | Machine resource with failure/PM |
| ⭐ `backend/storage/models.py` | Database schema |
| ⭐ `backend/api/routes/simulations.py` | Run trigger + SSE streaming |
| ⭐ `frontend/src/pages/RunDashboard.tsx` | Primary results UI |
| ⭐ `frontend/src/pages/Canvas.tsx` | Visual flow builder |
| `backend/parsers/excel_parser.py` | Complex multi-format Excel parser |
| `backend/engine/ai_insights.py` | AI recommendations engine |
| `tshirt_factory.yaml` | Reference scenario for understanding data format |

---

## 9. Configuration

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string, e.g. `postgresql+psycopg://linksim:<password>@127.0.0.1:5432/linksim` |
| `LINKSIM_CORS_ORIGINS` | localhost:5173,3000,8000 | Allowed CORS origins |

**Config files:**
- `requirements.txt` — Python dependencies
- `frontend/package.json` — Node dependencies
- `frontend/vite.config.ts` — Vite dev server + API proxy (`/api -> localhost:8000`)
- `tshirt_factory.yaml` — Example scenario configuration

**No `.env` file is committed** (gitignored). No secrets or API keys needed.

---

## 10. Database

**Schema (3 tables):**

```
scenarios
+-- id (PK)
+-- name, description
+-- created_at, updated_at
+-- source_filename, source_file (original file bytes)
+-- stations_data (JSON)
+-- processflow_data (JSON)
+-- variant_quantities (JSON)
+-- operators_data (JSON)
+-- simulation_config (JSON)

simulation_runs
+-- id (PK)
+-- scenario_id (FK -> scenarios)
+-- status (pending|running|completed|failed)
+-- created_at, completed_at
+-- completed_jobs, in_progress_jobs, simulation_time
+-- num_replications
+-- kpi_throughput, kpi_avg_utilization, kpi_peak_utilization
+-- kpi_bottleneck_station, kpi_stations_at_risk
+-- kpi_total_failures, kpi_avg_rework_pct, kpi_sim_days
+-- result (JSON — full simulation output)
+-- error_message

station_stats
+-- id (PK)
+-- run_id (FK -> simulation_runs)
+-- station_name
+-- station_utilization, operator_utilization
+-- rework_percentage, rework_time_ratio
+-- completed_jobs, throughput, busy_time
+-- avg_block_time, failure_breakdowns, pm_breakdowns
+-- top_bottleneck_type, top_bottleneck_metric
```

**ORM:** SQLAlchemy 2.0 with `DeclarativeBase`. No migrations currently (uses `create_all()`). Alembic is in requirements but not configured.

**Relationships:** `Scenario -> SimulationRun` (one-to-many, cascade delete), `SimulationRun -> StationStat` (one-to-many, cascade delete).

---

## 11. Business Logic

In simple terms, the simulation works like this:

1. **Define a factory:** Stations (machines with capacity, failure rates, PM schedules), operators (with skill ratings and availability), process flows (sequence of operations), and production quantities.

2. **Run the simulation:** SimPy creates virtual time. Each job (e.g., "T-shirt #1") flows through the process: Cutting -> Stitching -> Quality Check -> Packaging. At each station:
   - Wait for the machine to be available (capacity constraint)
   - Wait for shift to start (shift scheduling)
   - Handle random machine failures (exponential distribution)
   - Wait for operator to be available (availability check)
   - Process in chunks (respecting shift windows)
   - Check for material shortages (probabilistic)
   - Check for rework (probabilistic, based on rework %)
   - Track all time components

3. **Calculate KPIs:** Utilization %, throughput (jobs/hour), bottleneck identification, rework rate, failure counts, time allocation breakdown.

4. **Generate insights:** Rule-based AI engine analyzes patterns and generates strategic/operational/predictive recommendations.

---

## 12. API Documentation

### Scenarios

| Route | Method | Input | Output | Auth |
|---|---|---|---|---|
| `/api/scenarios/` | POST | `ScenarioCreate` JSON | `ScenarioResponse` (201) | None |
| `/api/scenarios/` | GET | query: skip, limit | `List[ScenarioListItem]` | None |
| `/api/scenarios/{id}` | GET | path: id | `ScenarioResponse` | None |
| `/api/scenarios/{id}` | PATCH | `ScenarioUpdate` JSON | `ScenarioResponse` | None |
| `/api/scenarios/{id}` | DELETE | path: id | 204 No Content | None |
| `/api/scenarios/{id}/file` | GET | path: id | Binary file download | None |
| `/api/scenarios/{id}/validate` | GET | path: id | Validation report JSON | None |

### Simulations

| Route | Method | Input | Output | Auth |
|---|---|---|---|---|
| `/api/simulations/{id}/run` | POST | `RunRequest` (num_replications, sim_config_override) | `RunResponse` (202) | None |
| `/api/simulations/{id}/stream` | GET | path: id | SSE event stream | None |
| `/api/simulations/{id}/runs` | GET | path: id | `List[RunResponse]` | None |
| `/api/simulations/runs/{id}` | GET | path: id | `RunDetailResponse` | None |

### Upload

| Route | Method | Input | Output |
|---|---|---|---|
| `/api/upload/scenario` | POST | File (yaml/xlsx) | `UploadResponse` |
| `/api/upload/csv-bundle` | POST | 4 CSV files | `UploadResponse` |
| `/api/upload/flat-csv` | POST | 1 CSV file | `UploadResponse` |

### Insights

| Route | Method | Input | Output |
|---|---|---|---|
| `/api/insights/{run_id}` | GET | path: run_id | `InsightsResponse` |

### Debug

| Route | Method | Input | Output |
|---|---|---|---|
| `/api/debug/log` | GET | query: lines | Log tail JSON |
| `/api/debug/runs` | GET | — | Recent runs list |
| `/api/debug/runs/{id}` | GET | path: id | Run detail + error |

**Error handling:** All routes raise `HTTPException` with appropriate status codes (404, 400, 422). Validation errors from Pydantic return structured 422 responses.

---

## 13. Authentication & Authorization

**None.** The application has no authentication, authorization, sessions, or JWT. All endpoints are publicly accessible. This is a single-user/team tool. If deployed externally, auth would need to be added.

---

## 14. Data Flow — Full Trace: Import a YAML and Run a Simulation

```
1. User selects tshirt_factory.yaml in ScenarioManager upload dialog
2. scenariosApi.importFile(file, "T-Shirt Factory")
   -> POST /api/upload/scenario (file bytes)
   -> ParserFactory.parse_all() detects .yaml -> YamlParser.parse_all()
   -> Returns {stations, operators, processflow, variant_quantities, simulation_config}
3. scenariosApi.create(payload)
   -> POST /api/scenarios/ -> crud.create_scenario() -> INSERT INTO scenarios -> DB
4. Frontend navigates to /run
5. User clicks "Run" button
   -> simulationsApi.triggerRun(scenarioId, {SIM_TIME: 480})
   -> POST /api/simulations/{id}/run
   -> crud.create_run() -> INSERT INTO simulation_runs -> DB (status: pending)
   -> BackgroundTasks.add_task(_execute_run, ...)
   -> Returns RunResponse (202)
6. Frontend opens EventSource -> GET /api/simulations/{id}/stream
7. Background thread _execute_run():
   -> crud.mark_run_running() -> UPDATE status='running'
   -> ManufacturingSimulation(...) -> sim.run()
   -> SimPy processes run: 200 t-shirts flow through 4 stations
   -> Progress callbacks -> progress_store.push({type: "progress", pct: 45, msg: "..."})
   -> SSE streams events to frontend
8. sim.run() completes -> returns result dict
9. crud.complete_run(run_id, result):
   -> UPDATE status='completed', result=JSON, kpi_*=values
   -> INSERT INTO station_stats (4 rows, one per station)
10. progress_store.push({type: "done", completed_jobs: 198})
11. Frontend receives "done" -> fetches GET /api/simulations/runs/{id}
12. RunDetailResponse renders KPI cards, charts, station breakdowns
13. User clicks "AI Insights" -> GET /api/insights/{run_id}
14. AIInsightsEngine.generate_insights() -> strategic/operational/predictive/risk recommendations
15. Insights page renders insight cards
```

---

## 15. Lifecycle

**Application startup:**
1. Python loads `main.py`
2. Logging configured (file + console)
3. Uvicorn creates FastAPI app
4. `lifespan()` calls `init_db()` -> `Base.metadata.create_all()` creates tables if missing
5. CORS middleware configured, routers registered
6. Server listening on port 8000

**During a user request (simulation run):**
1. FastAPI receives POST -> creates DB record -> spawns background task -> returns 202
2. Background thread: loads scenario from DB -> creates SimPy environment -> spawns job processes -> runs until SIM_TIME -> saves results -> cleans up
3. SSE endpoint: polls progress_store every 250ms -> streams JSON events -> cleans up on "done"

**During shutdown:**
- FastAPI lifespan `yield` point is reached; no explicit cleanup (database connections are pooled by SQLAlchemy, SimPy is stateless)

---

## 16. Dependencies

| Dependency | Why |
|---|---|
| **FastAPI** | Modern async Python web framework with automatic OpenAPI docs |
| **SimPy** | Industry-standard discrete event simulation library |
| **SQLAlchemy** | ORM over PostgreSQL (driver: psycopg 3) |
| **Pandas** | Excel/CSV parsing (used by all parsers) |
| **openpyxl** | Reads .xlsx files |
| **PyYAML** | Reads YAML scenario files |
| **SciPy** | t-distribution for confidence interval calculations |
| **NumPy** | Used by Machine for random number generation |
| **Pydantic** | Request/response validation (built into FastAPI) |
| **React** | UI framework |
| **ReactFlow** | Visual node-based graph editor for process flows |
| **Recharts** | Bar charts for utilization visualization |
| **TanStack React Query** | Server state management, caching, polling |
| **Zustand** | Lightweight global state (active scenario, run, toast, theme) |
| **Tailwind CSS** | Utility-first CSS |
| **Axios** | HTTP client with interceptors for error formatting |

---

## 17. Error Handling

**Backend:**
- FastAPI `HTTPException` for client errors (404, 400, 422)
- Background task catches all exceptions -> `crud.fail_run()` saves error + traceback -> pushes error event to SSE
- SimPy processes catch individual step exceptions and continue (line 313-319 in `sim_core.py`)
- `_validate_config()` rejects invalid SIM_TIME values (0, negative, NaN, infinity)
- SIM_TIME above 525,600 (1 year) is clamped with a warning

**Frontend:**
- Axios interceptor (`client.ts`) flattens FastAPI error responses into readable messages
- React Query retries once on failure
- Toast notifications for success/error feedback
- Loading/empty/error states on all pages

**Logging:** Python `logging` module writes DEBUG level to `linksim.log` + console. Simulation progress logged with elapsed time.

---

## 18. Testing

**Location:** `backend/tests/test_smoke.py`

**Coverage (7 tests):**
1. `test_template_parses` — Excel template parses without error
2. `test_template_produces_nonzero_throughput` — Core regression: jobs complete
3. `test_run_does_not_raise_negative_delay` — No SimPy crashes
4. `test_parse_shift_window` — Shift time parsing unit test
5. `test_build_station_shift_config_overrides_and_falls_back` — Per-station shift override
6. `test_engine_uses_per_station_shift_windows` — Engine integration test
7. `test_multirep_preserves_bottleneck_data` — Multi-replication preserves bottleneck info
8. `test_zero_operator_station_does_not_gate` — Machine-only stations work
9. `test_operator_gating_still_applies_when_operators_present` — Operator blocking works
10. `test_invalid_sim_time_raises` — Invalid configs rejected (parametrized: 0, -100, "abc", inf, nan)
11. `test_runaway_sim_time_is_clamped` — Runaway values clamped

**No frontend tests currently.** No integration or E2E tests.

---

## 19. Security

- **No authentication** — all endpoints public
- **No input sanitization** beyond Pydantic validation
- **File uploads:** Only accepted extensions (.yaml, .xlsx, .csv); content parsed via Pandas
- **SQL injection:** Protected by SQLAlchemy ORM (parameterized queries)
- **XSS:** React escapes by default; no dangerouslySetInnerHTML
- **CORS:** Restricted to localhost origins by default; configurable via env var
- **File storage:** Source files stored as `LargeBinary` (bytea) in PostgreSQL (not filesystem)

**Potential vulnerabilities:** No rate limiting, no CSRF protection, no auth, debug endpoints exposed in production.

---

## 20. Performance

- **Caching:** React Query has `staleTime: 10s` (brief cache)
- **No lazy loading** — all pages eagerly loaded
- **Pagination:** Scenario list supports `skip/limit` (default 50)
- **Database:** PostgreSQL everywhere (the desktop build runs its own private PostgreSQL)
- **Simulation:** Runs synchronously in a background thread (not async). Large simulations (1 year, 200 jobs) complete in seconds. `MAX_SIM_TIME = 525,600` prevents runaway runs
- **No background job queue** — single background task per run (FastAPI BackgroundTasks)
- **SSE polling:** 250ms interval for progress events (efficient enough for the use case)

---

## 21. Code Walkthrough — Entry Point to Full Initialization

```
1. uvicorn main:app --reload --port 8000
2. Python imports main.py
3. Lines 14-24: logging.basicConfig() -> file handler + console handler
4. Line 27: from backend.storage.database import init_db
5. Lines 28-34: Import all 5 routers
6. Lines 37-41: Define lifespan() async context manager
7. Lines 44-49: app = FastAPI(title="LinkSim API", lifespan=lifespan)
8. Lines 55-71: CORS middleware added
9. Lines 74-78: Routers included (scenarios, simulations, upload, insights, debug)
10. Lines 81-83: /health endpoint defined
11. Uvicorn starts -> lifespan() fires -> init_db() -> create_all() -> tables created
12. App ready on http://localhost:8000
13. Frontend: npm run dev -> Vite on :5173 -> proxies /api to :8000
14. Browser loads -> React mounts -> BrowserRouter -> ScenarioManager page
```

---

## 22. Feature Walkthrough — Upload a YAML and Run

Already covered in detail in **Section 14 (Data Flow)**.

---

## 23. Call Graph — Simulation Run

```
trigger_run()
  +-- crud.create_run()
  +-- progress_store.init()
  +-- BackgroundTasks.add_task(_execute_run)
       +-- crud.mark_run_running()
       +-- _coerce_sim_config()
       +-- ManufacturingSimulation.__init__()
       +-- sim.run()                          [if num_reps == 1]
       |    +-- _validate_config()
       |    +-- _reset_state()
       |    |    +-- _compute_cycle_times()
       |    |    +-- _init_resources() -> Machine.__init__()
       |    +-- _run_simpy()
       |    |    +-- _process_variant() [SimPy generator, per job]
       |    |    |    +-- _perform_operation() [per station step]
       |    |    |         +-- resource.request() [yield]
       |    |    |         +-- _handle_machine_downtime()
       |    |    |         +-- _handle_operator()
       |    |    |         +-- SimulationUtils.check_material_shortage()
       |    |    |         +-- env.timeout(chunk) [yield]
       |    |    |         +-- SimulationUtils.check_rework()
       |    |    +-- env.run(until=SIM_TIME)
       |    +-- _post_process()
       |    |    +-- calc_station_utilization()
       |    |    +-- calc_operator_utilization()
       |    |    +-- identify_bottlenecks()
       |    |    +-- calculate_affected_jobs()
       |    |    +-- event_analyse()
       |    +-- _collect_results()
       |         +-- build_summary()
       +-- sim.run_with_replications()        [if num_reps > 1]
       |    +-- [N x sim.run()]
       |    +-- _aggregate_replications()
       +-- crud.complete_run() -> INSERT station_stats
       +-- progress_store.push({type: "done"})
```

---

## 24. Sequence Diagrams

### Simulation Run

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as API Route
    participant BG as Background Task
    participant ENG as Engine
    participant DB as Database

    FE->>API: POST /api/simulations/{id}/run
    API->>DB: crud.create_run() [status=pending]
    API->>BG: BackgroundTasks.add_task(_execute_run)
    API-->>FE: 202 RunResponse

    FE->>API: GET /api/simulations/{id}/stream (SSE)

    BG->>DB: crud.mark_run_running()
    BG->>ENG: ManufacturingSimulation(...)
    BG->>ENG: sim.run()

    loop Progress Updates
        ENG-->>BG: progress_callback(pct, msg)
        BG->>BG: progress_store.push({type: "progress"})
        API-->>FE: SSE event (progress)
    end

    ENG-->>BG: result dict
    BG->>DB: crud.complete_run(result)
    BG->>BG: progress_store.push({type: "done"})
    API-->>FE: SSE event (done)

    FE->>API: GET /api/simulations/runs/{id}
    API->>DB: crud.get_run() + get_station_stats()
    API-->>FE: RunDetailResponse
```

### File Upload

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as API Route
    participant P as ParserFactory
    participant YP as YamlParser
    participant DB as Database

    FE->>API: POST /api/upload/scenario (file)
    API->>P: parse_all(content, filename)
    P->>YP: parse_all(source)
    YP-->>P: {stations, operators, processflow, ...}
    P-->>API: parsed dict
    API-->>FE: UploadResponse

    FE->>API: POST /api/scenarios/ (create with parsed data)
    API->>DB: crud.create_scenario()
    DB-->>API: Scenario
    API-->>FE: ScenarioResponse
```

---

## 25. Class Diagrams

```mermaid
classDiagram
    class ManufacturingSimulation {
        +Dict stations_data
        +Dict processflow_data
        +Dict variant_quantities
        +Dict operators_data
        +Dict sim_config
        +simpy.Environment env
        +Dict resources
        +run() Dict
        +run_with_replications(n) Dict
        -_validate_config()
        -_reset_state()
        -_run_simpy()
        -_process_variant(id, type)
        -_perform_operation(...)
        -_post_process()
        -_collect_results()
    }

    class Machine {
        +float failure_rate
        +float repair_time
        +bool working
        +int failure_count
        +int pm_count
        +simpy.Resource mutex
        -_run_failure_cycle()
        -_run_preventive_maintenance()
        +get_downtime_report() dict
    }

    class AIInsightsEngine {
        +generate_insights(...) Dict
        -_strategic(...) List
        -_operational(...) List
        -_predictive(...) List
        -_optimization(...) List
        -_risks(...) List
        -_trends(...) Dict
        -_confidence(...) float
    }

    class Scenario {
        +int id
        +String name
        +JSON stations_data
        +JSON processflow_data
        +JSON operators_data
        +JSON simulation_config
    }

    class SimulationRun {
        +int id
        +int scenario_id
        +String status
        +JSON result
        +Float kpi_throughput
        +Float kpi_avg_utilization
    }

    class StationStat {
        +int run_id
        +String station_name
        +Float station_utilization
        +Float operator_utilization
        +Int completed_jobs
    }

    ManufacturingSimulation --> Machine : uses
    Machine ..|> simpy.Resource : extends
    Scenario "1" --> "*" SimulationRun : has
    SimulationRun "1" --> "*" StationStat : has
```

---

## 26. Dependency Graph

```mermaid
graph TD
    main["main.py"]
    routes_sc["routes/scenarios.py"]
    routes_sim["routes/simulations.py"]
    routes_up["routes/upload.py"]
    routes_ins["routes/insights.py"]
    routes_dbg["routes/debug.py"]
    schemas["schemas.py"]
    crud["crud.py"]
    db["database.py"]
    models["models.py"]
    sim_core["sim_core.py"]
    machine["machine.py"]
    formulas["formulas.py"]
    sim_utils["sim_utils.py"]
    bottleneck["bottleneck.py"]
    ai_insights["ai_insights.py"]
    progress["progress_store.py"]
    factory["factory.py"]
    yaml_p["yaml_parser.py"]
    excel_p["excel_parser.py"]
    csv_p["csv_parser.py"]
    flat_csv["flat_csv_parser.py"]

    main --> routes_sc
    main --> routes_sim
    main --> routes_up
    main --> routes_ins
    main --> routes_dbg
    main --> db

    routes_sc --> crud
    routes_sc --> schemas
    routes_sim --> crud
    routes_sim --> schemas
    routes_sim --> sim_core
    routes_sim --> progress
    routes_up --> factory
    routes_up --> schemas
    routes_ins --> crud
    routes_ins --> ai_insights
    routes_dbg --> crud

    crud --> models
    crud --> db

    sim_core --> machine
    sim_core --> formulas
    sim_core --> sim_utils
    sim_core --> bottleneck
    machine --> formulas
    bottleneck --> formulas
    ai_insights --> formulas

    factory --> yaml_p
    factory --> excel_p
    factory --> csv_p
    factory --> flat_csv
    excel_p --> csv_p
    flat_csv --> csv_p
    yaml_p --> csv_p
```

---

## 27. Refactoring Opportunities

1. **Large files:** `RunDashboard.tsx` (~950 lines) and `Canvas.tsx` (~857 lines) are very large. Each KPI card component could be extracted to its own file.

2. **Code duplication:** `utilColor()`, `utilBg()`, `utilTextColor()` are defined separately in `RunDashboard.tsx` and `Canvas.tsx` — should be in `lib/utils.ts`.

3. **No service layer:** Route handlers directly call CRUD and engine. A service layer would improve testability.

4. **Alembic unused:** `alembic` is in requirements but no migration files exist. Should either set up or remove.

5. **Test coverage:** Only backend smoke tests. No frontend tests, no API integration tests.

6. **No auth:** Fine for dev, but production deployment would need authentication.

7. **components.py partially unused:** `Generator`, `Queue`, `Activity`, `Exit` classes in `engine/components.py` aren't used by the main simulation — they're legacy from the original Simul8 app.

8. **Hardcoded dates:** `datetime(2025, 1, 1, 6, 0, 0)` as simulation start date is hardcoded in `_reset_state()`.

9. **`_handle_operator` inconsistency:** At line 629, it references `self.sim_config` instead of `shift_cfg` for per-station shifts — potential bug for stations with different shift windows.

---

## 28. Learning Roadmap

Read in this order:

1. `tshirt_factory.yaml` — Understand the data model (what is a scenario?)
2. `backend/storage/models.py` — Database schema
3. `backend/api/schemas.py` — Request/response shapes
4. `main.py` — How the app starts
5. `backend/api/routes/scenarios.py` — Simplest CRUD route
6. `backend/api/routes/upload.py` — How files become data
7. `backend/parsers/yaml_parser.py` — YAML -> dict
8. `backend/engine/formulas.py` — KPI definitions
9. `backend/engine/machine.py` — Machine model with failure/PM
10. `backend/engine/sim_core.py` — The core simulation (read top-to-bottom)
11. `backend/api/routes/simulations.py` — How runs are triggered and streamed
12. `frontend/src/App.tsx` — Frontend routing
13. `frontend/src/api/scenarios.ts` — Frontend -> Backend communication
14. `frontend/src/pages/ScenarioManager.tsx` — Main page
15. `frontend/src/pages/RunDashboard.tsx` — Results display
16. `backend/engine/bottleneck.py` — Analysis logic
17. `backend/engine/ai_insights.py` — AI recommendations

---

## 29. Frequently Asked Questions

**Q: How do I run the project?**
```bash
# Terminal 1: Backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Terminal 2: Frontend
cd frontend
npm install
npm run dev
```

**Q: What's the difference between a "scenario" and a "run"?**
A scenario is the factory definition (stations, operators, process flow). A run is one simulation execution of that scenario with specific settings.

**Q: What file formats are supported?**
YAML, Excel (.xlsx), 4 separate CSVs (stations/operators/processflow/quantities), or a single flat process-routing CSV.

**Q: How does the simulation handle different shift schedules per station?**
Each station's `shift1/shift2/shift3` columns define time windows (e.g., "08:00-16:00"). If blank, the global config is used.

**Q: What does "replications" mean?**
Running the same scenario N times with different random seeds. Results are averaged with 95% confidence intervals for statistical validity.

**Q: Is there any authentication?**
No. This is a single-user/team development tool.

**Q: Which database does it use?**
PostgreSQL only. Set `DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/linksim` in `.env`.

---

## 30. Summary

LinkSim is a **manufacturing simulation tool** with a Python/FastAPI backend and React/TypeScript frontend. Users define factory production lines (stations with machines, operators, process flows) via file upload or visual canvas, run discrete-event simulations using SimPy, and view KPI dashboards with bottleneck analysis and AI-powered insights.

The architecture is clean and layered: **parsers** convert files to dicts, the **engine** runs SimPy simulations, **CRUD** persists results, **routes** expose REST APIs, and the **frontend** provides a polished SPA with visual flow building and real-time progress streaming.

The core innovation is the simulation engine (`sim_core.py`), which models real-world manufacturing constraints: shift scheduling, machine failures, operator availability, material shortages, and rework — all running in virtual time via SimPy.
