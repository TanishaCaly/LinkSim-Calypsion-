# LinkSim Frontend — Quick Start

## 1. Install dependencies (one-time)

```bash
cd linksim/frontend
npm install
```

## 2. Start the backend (separate terminal)

```bash
cd linksim
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## 3. Start the frontend

```bash
cd linksim/frontend
npm run dev
# Opens at http://localhost:5173
```

The frontend proxies all `/api/*` requests to `http://localhost:8000`.

---

## Screens

| Route | Description |
|---|---|
| `/` | Scenario Manager — import YAML/XLSX or 4 CSV files, browse saved scenarios |
| `/run` | Run Dashboard — trigger simulation, live poll status, utilisation charts |
| `/canvas` | Visual Canvas — drag-and-drop station builder using React Flow |
| `/insights` | AI Insights — strategic, operational, and risk recommendations |
