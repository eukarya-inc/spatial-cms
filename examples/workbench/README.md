# Data Workbench — Spatial CMS

## Why This Exists

The Data Workbench is **not part of the CMS product** — it's a standalone data quality tool that demonstrates how external tools interact with the CMS through the Management API.

In the Spatial CMS ecosystem, the CMS manages the governance workflow (define → manage → publish). But data quality operations — deduplication, cleansing, validation — are typically done by specialized tools, not by the CMS itself. This is by design: the CMS is the control plane, the Workbench is the operator's tool.

**This example demonstrates:**
- How external tools use the Management API to read entities and create proposals
- How to build a backend proxy with manage-scope API Key (secure pattern)
- How batch operations work through the proposal workflow (all changes are governed)
- How schema-driven tools can work with any model dynamically

**This is a starting point** — real data quality tools would be built by your team or data engineers, with specialized algorithms for their domain. The Workbench shows the integration pattern.

## Relationship to CMS

```
Spatial CMS (port 3001)
  │
  ├── Admin UI (built-in) — for data managers to define, manage, publish
  │
  ├── Delivery API ──────→ Viewer (examples/viewer)
  │
  ├── OGC API ───────────→ QGIS, ArcGIS
  │
  └── Management API ────→ Data Workbench (this app, port 8095)
                            Reads ALL data (including unpublished).
                            Creates proposals (update/delete).
                            Uses manage-scope API Key.
                            Changes go through CMS governance workflow.
```

The Workbench talks to the **Management API** — it can read all entities (not just published), read model schemas, and create proposals. It never writes data directly — all changes go through the CMS proposal → review → approve workflow.

## Architecture

```
Browser (index.html)
  ↓ /api/* (no API key exposed)
Workbench Backend (server.js, port 8095)
  ↓ proxy + inject X-API-Key (manage scope, from env)
Spatial CMS Management API (port 3001)
```

## How to Run

1. Start the CMS (see root [README.md](../../README.md))

2. Generate a **manage-scope** API Key in the CMS:
   - Go to `http://localhost:3001/#integrate/api-keys`
   - Click "Generate New Key" → scope: manage

3. Configure and start:
   ```bash
   cd examples/workbench
   cp .env.example .env
   # Edit .env: paste your manage-scope API key
   node server.js
   ```

4. Open `http://localhost:8095`

## Configuration (.env)

```
CMS_URL=http://localhost:3001/api/v1    # CMS Management API base URL
CMS_API_KEY=scms_your_key_here          # manage-scope API Key
PORT=8095                                # Workbench port
```

## Features

### Dedup
Find and resolve duplicate records:
- **Exact match** — group by identical field values
- **Fuzzy match** — Levenshtein distance with configurable threshold
- **Spatial proximity** — Haversine distance within configurable meters
- **Combined** — name similarity AND location proximity
- **Auto-resolve** — keep the most complete record, merge properties
- Stage delete/merge proposals → commit via CMS governance

### Cleanse
Clean and standardize field values:
- **Case transform** — UPPERCASE, lowercase, Title Case
- **Trim** — remove leading/trailing whitespace
- **Remove special characters**
- **Find & Replace** — with regex support
- **Fill empty values** — set defaults for null/empty fields
- Preview before/after → stage changes → commit

### Compute
Compute derived geometry from existing geometry fields:
- **Centroid** — polygon/any → center point
- **Bounding Box** — any → envelope polygon
- **Point on Surface** — polygon → interior-guaranteed point
- Select source field, operation, target field → preview → commit
- Validates "CMS manages data, external tools compute" architecture

### Validate (coming soon)
Data quality audit: completeness, type checking, pattern validation.

## Data Flow

```
1. Select model → Load all entities into memory
2. Use tools (Dedup, Cleanse, Compute) to analyze and stage changes
3. Changes accumulate in the Commit Bar (bottom)
4. Click "Create Proposals" → progress modal → proposals sent to CMS
5. Go to CMS Review Queue to approve/reject changes
```

**All changes go through the CMS proposal workflow. No direct writes.**

## API Proxy Mapping

| Browser request | Proxied to CMS |
|----------------|-----------------|
| `GET /api/definitions/models` | `GET /api/v1/definitions/models` + Key |
| `GET /api/definitions/models/:id/schema` | `GET /api/v1/definitions/models/:id/schema` + Key |
| `GET /api/entities?type=...` | `GET /api/v1/entities?type=...` + Key |
| `POST /api/proposals` | `POST /api/v1/proposals` + Key |

## API Key Scope

Requires **manage** scope (not delivery, not admin):
- **Can read**: model definitions, schemas, all entities
- **Can write**: create proposals (update/delete)
- **Cannot**: modify models, manage API keys, delete models

## Tech Stack

- Node.js backend proxy (zero dependencies)
- Vanilla HTML + JS frontend (no build tools)
- Spatial CMS Management API (data source)
