# Spatial CMS Viewer — Example Consumer App

A standalone demo application that consumes the Spatial CMS Delivery API.
Demonstrates how a real consumer application should be built: **frontend + backend proxy**.

## Architecture

```
Browser (index.html)
  ↓ fetch /api/datasets, /api/entities...  (no API key exposed)
Viewer Backend (server.js, port 8090)
  ↓ proxy + inject X-API-Key header (from environment variable)
Spatial CMS Delivery API (port 3001)
```

**The API Key never reaches the browser.** This is the correct pattern for any
application consuming a protected API — the key lives in the backend environment.

## How to Run

1. Start the CMS:
   ```bash
   cd /path/to/spatial-cms
   docker compose up -d
   npm run dev
   ```

2. Generate an API Key in the CMS:
   - Go to `http://localhost:3001/#integrate/api-keys`
   - Click "Generate New Key", copy the key

3. Configure and start the viewer:
   ```bash
   cd examples/viewer
   cp .env.example .env
   # Edit .env and paste your API key
   node server.js
   ```

4. Open `http://localhost:8090`

## Configuration (.env)

```
CMS_URL=http://localhost:3001/api/v1    # CMS Delivery API base URL
CMS_API_KEY=scms_your_key_here          # API Key (never exposed to browser)
PORT=8090                                # Viewer port
```

## Features

- 2D/3D map visualization (MapLibre GL JS)
- Dataset selection and schema discovery
- Spatial queries (bbox draw, near-point search)
- 3D building extrusion (height-based)
- API request logging
- Page size control

## API Proxy Mapping

| Browser request | Proxied to |
|----------------|------------|
| `GET /api/datasets` | `GET /api/v1/delivery/datasets` + X-API-Key |
| `GET /api/datasets/:id/entities` | `GET /api/v1/delivery/datasets/:id/entities` + X-API-Key |
| `GET /api/datasets/:id/schema` | `GET /api/v1/delivery/datasets/:id/schema` + X-API-Key |

## Tech Stack

- Node.js (backend proxy, zero dependencies)
- MapLibre GL JS (2D/3D map rendering)
- Vanilla HTML + JS (frontend)
- Spatial CMS Delivery API (data source)
