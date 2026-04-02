# Spatial CMS Viewer — Example Consumer App

A standalone demo application that consumes the Spatial CMS Delivery API.
Demonstrates how external developers would build applications on top of published spatial data.

## What This Is

This is **NOT** part of the CMS. It is an independent application that uses only the read-only Delivery API (`/api/v1/delivery/`). It demonstrates:

- 2D/3D map visualization (MapLibre GL JS)
- Dataset selection and schema discovery
- Search and filtering by properties
- Spatial queries (bbox draw, near-point search)
- 3D building extrusion (height-based)
- Data analysis (type distribution, height statistics)
- API request logging (Chrome DevTools style)

## How to Run

1. Start the CMS:
   ```bash
   cd /path/to/spatial-cms
   docker compose up -d
   npm run dev
   ```

2. Ensure data is published (run the seed script if needed):
   ```bash
   npx tsx scripts/seed-taito.ts
   ```

3. Open the viewer:
   ```bash
   cd examples/viewer
   python3 -m http.server 8090
   # or: npx serve .
   ```

4. If the CMS is on a different host, the viewer auto-detects the hostname.

## Features

- **Dataset selector** — switch between any published dataset
- **Load button** — manually fetch data (no auto-refresh on pan)
- **2D/3D toggle** — smooth animated transition (pitch 0 ↔ 60°)
- **3D extrusion** — buildings extruded by height property or Z coordinate
- **Bbox draw** — draw rectangle on map to spatial query
- **Near search** — click point to search within 300m radius
- **Filter chips** — auto-generated from schema enum fields
- **Schema panel** — shows all models and fields
- **API Log** — resizable panel showing all Delivery API requests + responses

## API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /delivery/datasets` | Discover available datasets |
| `GET /delivery/datasets/:id/schema` | Understand data structure |
| `GET /delivery/datasets/:id/entities?bbox=&pageSize=&format=geojson` | Load spatial data |
| `GET /delivery/datasets/:id/entities?near=&radius=` | Proximity search |
| `GET /delivery/datasets/:id/entities?page=&pageSize=` | Paginated list |

No authentication required. No write operations.

## Tech Stack

- MapLibre GL JS (2D/3D map rendering)
- Vanilla HTML + JS (no build tools)
- Spatial CMS Delivery API (data source)
