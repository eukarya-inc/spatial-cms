# Data Workbench — Spatial CMS

A standalone data quality workbench that connects to Spatial CMS via Management API.
Analyze, clean, validate, and transform entity data — all changes go through proposals.

## Architecture

```
Browser (index.html)
  ↓ /api/* (no API key exposed)
Workbench Backend (server.js, port 8095)
  ↓ proxy + inject X-API-Key (manage scope, from env)
Spatial CMS Management API (port 3001)
```

## How to Run

1. Start the CMS and generate a manage-scope API Key
2. Configure the workbench:
   ```bash
   cd examples/workbench
   cp .env.example .env
   # Edit .env: paste your manage-scope API Key
   node server.js
   ```
3. Open `http://localhost:8095`

## Features

### Dedup
Find and resolve duplicate records:
- Exact field match
- Fuzzy name match (Levenshtein distance)
- Spatial proximity (Haversine)
- Combined (name + location)
- Auto-resolve: keep most complete record
- Merge properties from duplicates into kept record

### Cleanse
Clean and standardize field values:
- Case transformation (UPPER, lower, Title Case)
- Trim whitespace
- Remove special characters
- Find & Replace (with regex support)
- Fill empty values with defaults

### Validate (coming soon)
Data quality audit and reporting.

### Transform (coming soon)
Batch transformation pipelines.

## Data Flow

1. Select model → Load entities
2. Use tools (Dedup, Cleanse) to identify and stage changes
3. Review pending changes in the commit bar
4. Create Proposals → changes sent to CMS for governance review

All changes go through the CMS proposal workflow. No direct writes.

## API Key Scope

Requires a **manage** scope key (not delivery, not admin).
- Reads: model definitions, schemas, entities
- Writes: create proposals (update/delete)

## Tech Stack

- Node.js backend proxy (zero dependencies)
- Vanilla HTML + JS frontend
- Spatial CMS Management API
