# Spatial CMS Viewer — Example Consumer App

## Why This Exists

This Viewer is **not part of the CMS product** — it's a reference implementation showing how a real-world application would consume published spatial data from the CMS.

In the Spatial CMS ecosystem, the CMS is the "kitchen" where data is governed, and consumer apps like this are the "restaurants" that serve it to end users. The CMS publishes data via the Delivery API; consumer applications fetch and visualize it.

**This example demonstrates:**
- How to build a frontend + backend proxy architecture (the correct production pattern)
- How to use the Delivery API to discover datasets, load schemas, and query entities
- How to handle API Key authentication securely (key in backend env var, never in browser)
- How to render 2D/3D spatial data with MapLibre GL JS

**This is a starting point** — real consumer applications would be built by your team or customers, with their own UI, business logic, and deployment. The Viewer shows the pattern they should follow.

## Relationship to CMS

```
Spatial CMS (port 3001)
  │
  ├── Admin UI (built-in) — for data managers to define, manage, publish
  │
  ├── Delivery API ──────→ Viewer (this app, port 8090)
  │                         Reads published data only. No write access.
  │                         Uses delivery-scope API Key.
  │
  ├── OGC API ───────────→ QGIS, ArcGIS (direct connection, no key)
  │
  └── Management API ────→ Data Workbench (examples/workbench)
```

The Viewer only talks to the **Delivery API** — it sees published data, never drafts, proposals, or internal state.

## Architecture

```
Browser (index.html)
  ↓ fetch /api/datasets, /api/entities...  (no API key exposed)
Viewer Backend (server.js, port 8090)
  ↓ proxy + inject X-API-Key header (from environment variable)
Spatial CMS Delivery API (port 3001)
```

**The API Key never reaches the browser.** This is the correct pattern for any application consuming a protected API — the key lives in the backend environment.

## How to Run

1. Start the CMS (see root [README.md](../../README.md))

2. Generate a **delivery-scope** API Key in the CMS:
   - Go to `http://localhost:3001/#integrate/api-keys`
   - Click "Generate New Key" → scope: delivery

3. Configure and start:
   ```bash
   cd examples/viewer
   cp .env.example .env
   # Edit .env: paste your delivery-scope API key
   node server.js
   ```

4. Open `http://localhost:8090`

## Configuration (.env)

```
CMS_URL=http://localhost:3001/api/v1    # CMS Delivery API base URL
CMS_API_KEY=scms_your_key_here          # delivery-scope API Key
PORT=8090                                # Viewer port
```

## Features

- **2D/3D toggle** — MapLibre GL JS with fill-extrusion for 3D buildings
- **Dataset selector** — switch between any published dataset
- **Spatial queries** — bbox draw, near-point search
- **Schema-driven** — field labels, types, filters from model schema
- **API Log** — see every Delivery API request and response
- **Page size control** — load 100 to all entities

## API Proxy Mapping

| Browser request | Proxied to CMS |
|----------------|-----------------|
| `GET /api/datasets` | `GET /api/v1/delivery/datasets` + X-API-Key |
| `GET /api/datasets/:id/entities` | `GET /api/v1/delivery/datasets/:id/entities` + X-API-Key |
| `GET /api/datasets/:id/schema` | `GET /api/v1/delivery/datasets/:id/schema` + X-API-Key |

## Tech Stack

- Node.js (backend proxy, zero dependencies)
- MapLibre GL JS (2D/3D map rendering)
- Vanilla HTML + JS (frontend, no build tools)
- Spatial CMS Delivery API (data source)
