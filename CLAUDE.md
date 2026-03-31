# Spatial CMS — Development Guide

## What is this?

Spatial data governance control plane (NOT a traditional CMS). Dual-kernel architecture:
- **Definition Kernel** — dynamic model/field/relation schema definitions
- **Governance Kernel** — proposal → approval → versioned entity → dataset snapshot → publish

Core invariant: **ALL data changes go through proposals. No direct entity writes.**

## Tech Stack

- Node.js + TypeScript + Express (backend API)
- PostgreSQL + PostGIS (database, Docker container on port 5434)
- Prisma ORM (geometry via `Unsupported` type + raw SQL)
- Directus (admin UI, Docker container on port 8055)
- Vanilla HTML + JS (frontend, served by Express)

## Quick Start

```bash
docker compose up -d          # PostGIS + Directus
npm run dev                   # Express on port 3001
```

## Project Structure

```
prisma/schema.prisma          # All 12 models, 12 enums
src/
  index.ts                    # Express app, route mounting, error handler
  db/client.ts                # Prisma singleton
  shared/
    geometry.ts               # PostGIS helpers (ST_AsGeoJSON, ST_GeomFromGeoJSON)
    validation.ts             # Zod schemas for API input
    dynamic-validation.ts     # Runtime validation against ModelDefinition fields
    errors.ts                 # BusinessError, NotFoundError classes
  modules/
    entity/                   # Entity read + internal create/update (used by proposal)
    proposal/                 # Create/approve/reject + auto-approval via governance
    dataset/                  # Dataset definitions + snapshot generation (dual-path)
    publication/              # Publish/rollback/hook
    ingestion/                # Bulk import + batch proposal creation + validation
    definition/               # Model/field/relation/binding/governance CRUD
    delivery/                 # Read-only API for external data consumers + OGC API
public/index.html             # Single-page admin UI (sidebar nav, hash router)
                              #   Dashboard: stats, records by model, recent activity, pending review
                              #   Content: entity list by model, search/filter, detail with
                              #     structured properties, version history, inline edit, status actions
                              #   Proposals: pending review + history, diff view for updates
                              #     batch approve (all or by model filter)
                              #   Datasets: manage bindings, snapshots, publish, publication history
                              #   Model Designer: model/field CRUD + governance policy columns
                              #   New Record: dynamic form from model schema → proposal
                              #   Publish Console: one-page publish workflow testing
                              #   API Playground: interactive endpoint explorer
scripts/
  seed.ts                     # Sample data
  migrate-entity-types.ts     # One-time entity.type → modelDefinitionId migration
```

## Key Patterns

### Prisma + PostGIS
Geometry uses `Unsupported("geometry(Geometry, 4326)")` (nullable). All geometry reads/writes go through `src/shared/geometry.ts` via `$queryRaw`/`$executeRaw`. Entity model has a manually-created GiST index.

### Prisma Migrations with Directus
Directus creates its own tables in the same schema, causing Prisma drift detection. Use this workflow:
1. Write migration SQL manually in `prisma/migrations/<timestamp>_<name>/migration.sql`
2. Apply: `npx prisma db execute --schema prisma/schema.prisma --file <migration.sql>`
3. Mark: `npx prisma migrate resolve --applied <migration_name>`
4. Generate: `npx prisma generate`

### Entity.type vs Entity.modelDefinitionId
Both exist. `type` is a denormalized string (always = `modelDefinition.key`). `modelDefinitionId` is the FK. Legacy entities may have `type` without `modelDefinitionId`. All new entities get both.

### Dataset Snapshot Dual-Path
`generateSnapshot()` checks for `DatasetModelBinding` records first. If found, queries by `modelDefinitionId`. If not, falls back to the legacy `entityTypes` JSON array.

### Proposal Auto-Approval
When `GovernancePolicy.approvalMode = "auto"` exists for a model, `createProposal()` automatically calls `approveProposal()` after validation passes. This applies to all proposal types (create, update, delete) — the model is resolved from `proposedChange.data.type` or from the entity's `modelDefinitionId` via `entityId`.

### Entity Status Lifecycle
Approved create proposals default to `active` status. Status changes (activate/archive) are done via proposals — the frontend creates a proposal and the backend auto-approves if the governance policy allows. No direct status writes.

### Governance Policy
Set per model via UI (Model Designer > model detail > Governance Policy) or API. Controls:
- `approvalMode`: `manual` (default) requires human review, `auto` auto-approves if validation passes
- `publishMode`: `manual` (default) or `auto`

### Entity Update Transactions
`updateEntityInternal()` uses `prisma.$transaction()` to atomically merge properties and increment version numbers. This prevents race conditions on concurrent updates.

### Properties Merge on Update
Entity updates merge new properties with existing ones (not replace). Orphaned properties (from deleted field definitions) are preserved. The edit form also preserves orphaned fields when submitting update proposals.

### Error Handling
Custom `BusinessError` and `NotFoundError` classes (in `src/shared/errors.ts`) replace fragile string matching. Prisma errors are handled by code: P2002 → 409 (duplicate), P2025 → 404 (not found). Auto-approval failures are logged via `console.warn`.

### Delivery API vs Management API
- **Management API** (`/api/v1/entities`, `/proposals`, etc.) — internal use by admin UI
- **Delivery API** (`/api/v1/delivery/`) — read-only, external consumers, only published data
- **Ingestion API** (`/api/v1/ingestion/`) — data pipelines, supports governed/direct/proposal modes

## API Endpoints

### Content
- `GET /api/v1/entities` — list (supports `?type=` and `?status=` filters)
- `GET /api/v1/entities/:id` — detail with geometry
- `GET /api/v1/entities/:id/versions` — version history

### Proposals
- `POST /api/v1/proposals` — create (actions: create/update/delete)
- `GET /api/v1/proposals` — list (supports `?status=` filter)
- `POST /api/v1/proposals/:id/approve` — approve (runs dynamic validation)
- `POST /api/v1/proposals/:id/reject`
- `POST /api/v1/proposals/approve-batch` — batch approve (all, by model filter, or by IDs)

### Definitions
- `CRUD /api/v1/definitions/models` — model definitions
- `CRUD /api/v1/definitions/models/:id/fields` — field definitions
- `GET /api/v1/definitions/models/:id/schema` — JSON schema for frontend
- `POST /api/v1/definitions/relations` — relation definitions
- `CRUD /api/v1/definitions/datasets/:id/bindings` — model-dataset bindings
- `CRUD /api/v1/definitions/governance/policies` — governance policies

### Datasets & Publishing
- `CRUD /api/v1/datasets` — dataset definitions
- `POST /api/v1/datasets/:id/snapshot` — generate snapshot
- `POST /api/v1/publications/publish` — publish snapshot
- `POST /api/v1/publications/rollback` — rollback

### Ingestion
- `POST /api/v1/ingestion/validate` — validate entities against model (no write)
- `POST /api/v1/ingestion/import` — bulk import (trusted, bypasses review)
- `POST /api/v1/ingestion/governed` — governed import (respects governance policy)
- `POST /api/v1/ingestion/proposal-set` — batch proposal creation (all pending)

### Delivery (read-only, for external consumers)
- `GET /api/v1/delivery/datasets` — list published datasets
- `GET /api/v1/delivery/datasets/:id` — published dataset metadata
- `GET /api/v1/delivery/datasets/:id/schema` — model schemas (fields, types, constraints)
- `GET /api/v1/delivery/datasets/:id/entities` — entities with query support:
  - `?page=1&pageSize=100` — pagination (max 1000)
  - `?bbox=minLon,minLat,maxLon,maxLat` — bounding box spatial query
  - `?near=lon,lat&radius=meters` — proximity search
  - `?filter[field]=value` or `?filter[field][$gte]=100` — property filtering
  - `?sort=field:asc` — sorting
  - `?format=geojson` — GeoJSON FeatureCollection output
- `GET /api/v1/delivery/datasets/:id/entities/:entityId` — single entity

### OGC API - Features (standard-compliant, for GIS tools)
- `GET /api/v1/ogc/` — landing page
- `GET /api/v1/ogc/conformance` — conformance declaration
- `GET /api/v1/ogc/collections` — published datasets as OGC collections
- `GET /api/v1/ogc/collections/:id` — collection metadata
- `GET /api/v1/ogc/collections/:id/schema` — JSON Schema format
- `GET /api/v1/ogc/collections/:id/items` — GeoJSON FeatureCollection (`?limit=`, `?offset=`, `?bbox=`)
- `GET /api/v1/ogc/collections/:id/items/:featureId` — single GeoJSON Feature

## Frontend Pages (hash routes)

Organized by product workflow: **Define → Manage → Publish**

| Route | Section | Page |
|-------|---------|------|
| `#dashboard` | Manage | Dashboard: stats, activity, pending review |
| `#define/models` | Define | Model Designer list + create + governance columns |
| `#define/models/{id}` | Define | Fields, relations, governance policy |
| `#manage/records` | Manage | All records with search/filter |
| `#manage/records/{modelKey}` | Manage | Records filtered by model |
| `#manage/records/{modelKey}/{id}` | Manage | Entity detail + structured props + version history + edit |
| `#manage/new/{modelKey}` | Manage | Dynamic form → create proposal |
| `#manage/review` | Manage | Review queue + batch approve + history |
| `#manage/review/{id}` | Manage | Proposal detail + diff view + approve/reject |
| `#publish/datasets` | Publish | Dataset list + create |
| `#publish/datasets/{id}` | Publish | Bindings + snapshots + publish + publication history |
| `#publish/delivery` | Publish | Delivery API docs + inline preview |
| `#publish/ogc` | Publish | OGC Services docs + QGIS connection guide |
| `#integrate/ingestion` | Integrate | Import API docs + test data generator + validate/import |
| `#dev/api` | Dev Only | Interactive API endpoint explorer |
| `#dev/console` | Dev Only | One-page publish workflow testing |

Old routes (`#content`, `#models`, `#proposals`, `#datasets`, `#publications`, `#api-playground`, `#publish-console`) auto-redirect to new paths.

## Ports

| Service | Port |
|---------|------|
| Express API + Frontend | 3001 |
| PostgreSQL + PostGIS | 5434 |
| Directus | 8055 |

## Credentials

- **Directus**: admin@example.com / admin
- **PostgreSQL**: spatial_cms / spatial_cms / spatial_cms (user/pass/db)
