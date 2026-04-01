# Dedup Tool — Spatial CMS Example

A standalone data quality tool that uses the Management API to find and resolve duplicate records.

## What This Is

This is **NOT** part of the CMS. It demonstrates how external tools can use the Management API to read data, analyze it, and create proposals for changes.

## How to Run

1. Start the CMS:
   ```bash
   cd /path/to/spatial-cms
   docker compose up -d
   npm run dev
   ```

2. Open the tool:
   ```bash
   cd examples/dedup
   npx serve .
   # or: python3 -m http.server 8091
   ```

3. If the CMS is on a different host, the tool auto-detects the hostname.

## Features

### Duplicate Detection Strategies
- **Exact field match** — Groups records with identical field values
- **Fuzzy name match** — Uses Levenshtein distance with configurable similarity threshold
- **Near location** — Finds records within configurable distance (meters)
- **Combined** — Name similarity AND spatial proximity

### Resolution
- Click records to toggle keep/delete status
- **Auto-resolve** — Automatically keeps the record with most complete data
- **Create Proposals** — Generates update (merge) + delete proposals in CMS
- Review and approve in CMS Review Queue

## API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /definitions/models` | List available models |
| `GET /definitions/models/:id/schema` | Get field definitions |
| `GET /entities?type=&page=&pageSize=` | Load entity data |
| `POST /proposals` | Create update/delete proposals |

## Tech Stack

- Vanilla HTML + JS (no build tools)
- Management API (read + write)
- All analysis runs in the browser
