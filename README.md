# LinkSim

Manufacturing discrete-event simulation (DES) tool. Import real factory data, review the process flow visually, run a realistic simulation (shifts, breakdowns, rework, buffers, changeovers), and get back KPIs, a Gantt timeline, per-job traceability, and rule-based insights.

**Stack:** FastAPI + SimPy + SQLite (backend) · React 19 + TypeScript + Vite + ReactFlow + Recharts (frontend)

---

## Prerequisites

- Python 3.11 or 3.12
- Node.js 20 LTS (or newer)
- Git

---

## Setup

### 1. Backend

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If PowerShell blocks the activation script:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 2. Run the backend

```powershell
uvicorn main:app --reload --port 8000
```

Check it's alive: `http://localhost:8000/health`

### 3. Frontend (second terminal)

```powershell
cd frontend
npm install
npm run dev
```

### 4. Open the app

`http://localhost:5173`

**Default login:** username `admin`, password `linksim123` (override via the `LINKSIM_USERNAME` / `LINKSIM_PASSWORD` environment variables before starting the backend).

---

## Project layout

```
backend/
  api/
    routes/          # scenarios, simulations, upload, insights, debug
    auth.py          # shared-credential login, session tokens
    schemas.py        # Pydantic request/response models
  engine/
    sim_core.py       # ManufacturingSimulation — the SimPy engine
    machine.py         # per-station failure/PM subsystem
    sim_utils.py        # shift/schedule helpers
    formulas.py           # single source of truth for every KPI formula
    bottleneck.py           # bottleneck detection/recommendations
    ai_insights.py            # rule-based insights engine
  parsers/            # yaml_parser, excel_parser, csv_parser, flat_csv_parser
  storage/            # SQLAlchemy models, CRUD, DB session
frontend/
  src/
    pages/            # ScenarioManager, Canvas, RunDashboard, Insights, Login
    api/               # axios client + per-resource API wrappers
    store/              # Zustand global state
    components/           # shared UI + layout
main.py               # FastAPI app entry point
```

---

## Importing data

Three formats are supported:

| Format | Endpoint |
|---|---|
| Single Excel/YAML file | `POST /api/upload/scenario` |
| 4-file CSV bundle (Stations / Operators / ProcessFlow / VariantQuantities) | `POST /api/upload/csv-bundle` |
| Single flat routing CSV | `POST /api/upload/flat-csv` |

Parsing is robust to messy real-world spreadsheets: auto-detected header rows, fuzzy column-name matching (spaces/hyphens/underscores treated as equivalent), NaN/blank-row hardening, and partial imports are allowed (a file isn't rejected unless every section comes back empty).

### Station attributes (Stations sheet/CSV)

| Column | Meaning | Default if blank |
|---|---|---|
| `Capacity` | Parallel machine slots | 1 |
| `shifts_per_day` | 0/3 = 24/7, 1/2 = Mon-Fri only | 1 |
| `operator_per_station` | Operators per parallel slot | 1 |
| `Failure rate` | Daily breakdown probability (legacy — only used when `MTBF` is blank; can only express MTBF >= 1440 min) | 0 |
| `MTBF` | Mean Time Between Failures, in minutes — primary reliability input, no ceiling. Edited via Availability%+MTTR in the Process Flow tab | blank (falls back to `Failure rate`) |
| `Repair Time` | MTTR (minutes) | 10 |
| `Setup time` | Changeover time — only charged when the station switches to a **different** product than it just ran | 0 |
| `Buffer Capacity` | Max jobs waiting for this station (scalar). `0` is a literal zero-room cap (strict lockstep with the upstream station), not "unlimited" — check `Buffer Unlimited` for that | 0 (zero room) |
| `Buffer Unlimited` | When set, ignores `Buffer Capacity`'s number entirely and allows unlimited queue. Accepts TRUE/FALSE, yes/no, 1/0 | If this column is absent: unlimited (true) when no `Buffer Capacity` column is present either, otherwise false |
| `Buffer Discipline` | `FIFO` or `LIFO` — which waiting job goes next | FIFO |
| `PM Schedule` | Monthly / Bi-Weekly / Weekly | Monthly |

### Variant Quantities sheet/CSV

| Column | Meaning |
|---|---|
| `Variant` | Product/variant name |
| `Quantity` | Units to produce |
| `Interval` | Minutes between successive job arrivals for that variant (fixed spacing). Blank = all jobs spawn at once |

### Process Flow sheet/CSV

| Column | Meaning |
|---|---|
| `Variant` | Product/variant name |
| `Operation` | Step name |
| `Resource` | Station this step runs at |
| `Duration` | Cycle time (minutes) |
| `Rule` *(optional)* | `round_robin`, `percentage`, `condition`, or `shortest_queue` — only needed for a branching step (see below) |
| `Condition/Weight` *(optional)* | Mode-specific value: a weight number for `percentage`, a variant name to match for `condition`, blank otherwise |

**A step with exactly one row works exactly as it always has** — a single destination station, no routing involved.

**To branch** (send a finished job to one of several possible next stations), add a **second row for the same Variant + Operation**, naming the alternate station. Example — 70/30 percentage split after "Paint":

| Variant | Operation | Resource | Duration | Rule | Condition/Weight |
|---|---|---|---|---|---|
| ALL | Paint | StationA | 5 | percentage | 70 |
| ALL | Paint | StationB | 5 | percentage | 30 |

Or route by product ("Exit controller type" — condition mode):

| Variant | Operation | Resource | Duration | Rule | Condition/Weight |
|---|---|---|---|---|---|
| ProductX | Inspect | StationA | 3 | condition | ProductX |
| ProductY | Inspect | StationB | 3 | condition | ProductY |

`round_robin`/`shortest_queue` use the same shape (multiple rows naming each candidate station); `Condition/Weight` is ignored for `shortest_queue`.

This can also be drawn directly on the **Visual Canvas** — draw two or more arrows out of one station, and its property panel shows an "Exit Controller" section to pick the mode.

### Setup Matrix sheet/CSV *(optional)*

A per-product-pair changeover matrix — solves the case where switching a station from Product A to Product B takes a different amount of time than switching to Product C (e.g. thread/needle change vs. just a color change). Entirely optional; a station/pair not listed here just falls back to its flat `Setup time` column (existing behaviour, unchanged).

| Column | Meaning |
|---|---|
| `Station` | Which station this changeover applies to |
| `From` | Variant the station just finished running |
| `To` | Variant the station is switching to |
| `Setup Time` | Minutes this specific changeover takes |

Example:

| Station | From | To | Setup Time |
|---|---|---|---|
| Stitching | TShirt | Hoodie | 10 |
| Stitching | TShirt | Jeans | 30 |
| Stitching | Hoodie | Jeans | 15 |
| Stitching | Hoodie | TShirt | 10 |
| Stitching | Jeans | TShirt | 30 |
| Stitching | Jeans | Hoodie | 15 |

Only list the specific pairs that matter — anything not listed (including same-product runs, which never charge setup time regardless) falls back to `Setup time`. Not yet exposed in the Scenario preview UI or Canvas — currently import/engine/results only.

---

## Running a simulation

- Trigger via `POST /api/simulations/{scenario_id}/run`; live progress streams over SSE at `GET /api/simulations/{run_id}/stream`.
- Supports statistical replications (`num_replications`) with real 95% confidence intervals.
- Results are viewable on the Run & Results dashboard: KPIs, Gantt Timeline, and **Job Trace** (see below).

### Job Trace

Every job gets a stable ID (e.g. `ProductA-003`) and a full per-station record:

| Field | Description |
|---|---|
| Job ID | Stable identifier per job |
| Station | Which station this row is about |
| Arrival / Departure | Real timestamps |
| Duration | Minutes spent at that station |
| Status | `Completed`, `In Progress` (sim ended mid-cycle), or `Waiting` (sim ended before the job ever got the machine) — no job silently disappears from the trace |
| Delay Reason | Automatically computed: whichever single cause (machine breakdown, waiting for operator, waiting for material, changeover, rework, or queueing) cost that job the most time at that station |

---

## Licensing

Licenses come from the Calypsion licensing server (https://license.calypsion.com,
product `LINKSIM`); see `backend/licensing.py`. Set with `LINKSIM_LICENSE`:

| Mode | Used by | How it works |
|---|---|---|
| `off` | development (default) | nothing is restricted |
| `machine` | desktop build (default when `LINKSIM_DESKTOP=1`) | one license for the PC, entered **before** login, saved in the data folder |
| `user` | hosted web version | each account enters its own key **after** login; saved in the `user_licenses` table; one seat per account |

The licensing API key (Backoffice → Settings → API clients, scoped to LINKSIM)
goes in `LINKSIM_LICENSE_API_KEY` — in the web server's environment, or into the
desktop build via `packaging/build.ps1`. Never commit it.

Web server example:

```bash
LINKSIM_LICENSE=user LINKSIM_LICENSE_API_KEY=lsk_... uvicorn main:app --port 8000
```

The license's features gate the app: `sim.run`, `import.excel`, `insights.ai`,
`view.3d`, `limit.stations`, `limit.scenarios`. A feature the license doesn't
mention is not restricted.

---

## Known gaps / not yet built

- **AI Insights is rule-based, not machine learning** — deterministic thresholds and formulas, no LLM call anywhere.
- **PDF export is browser print** (`window.print()`), not a server-generated file.
- **No Robot/Conveyor/AGV concept** — Buffer X/Y/Z models physical rack access, but not physical transport/travel time.
- **Dismantle, Variable** — not implemented.
- **Data Table** is implemented only in its "Setup Matrix" form (per-product-pair changeover time — see above). A general-purpose, user-defined lookup table (arbitrary columns referenced by other formulas/routing conditions, à la Simio's Data Table or FlexSim's Global Table) is not implemented.
- **Buffer X/Y/Z** enforces lane/depth access order; it does not yet integrate with a transport resource's travel time.

---

## Development notes

- All KPI formulas live in `backend/engine/formulas.py` — the single source of truth; every other module imports from it, not re-derives.
- DB schema changes during development were applied via direct `ALTER TABLE` (no Alembic migrations are wired up yet, despite `alembic` being in `requirements.txt`).
- Run the backend test suite: `pytest backend/tests/`
- Typecheck the frontend: `cd frontend && npx tsc --noEmit`
