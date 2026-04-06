# Spatial CMS — Development Guide

## What is this?

Spatial data governance control plane (NOT a traditional CMS). Dual-kernel architecture:
- **Definition Kernel** — dynamic model/field/reference schema definitions
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
docker compose up -d          # PostGIS + Directus + Keycloak
npm run dev                   # Express on port 3001
npm test                      # Run 47 integration tests
```

## Project Structure

```
prisma/schema.prisma          # All 12 models, 12 enums
src/
  app.ts                      # Express app creation + routes + error handler (exportable)
  index.ts                    # Server startup (imports app.ts, calls listen)
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
    definition/               # Model/field/binding/governance CRUD
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
  seed-taito.ts               # Real data: 1000 buildings from OSM (Tokyo Taito-ku)
  migrate-entity-types.ts     # One-time entity.type → modelDefinitionId migration
tests/
  README.md                   # Test documentation + template
  helpers/
    api.ts                    # Test server on random port + HTTP request helper
    setup.ts                  # DB cleanup + test model/policy factory
  integration/
    version-geometry.test.ts  # Geometry preserved in version snapshots (regression)
    proposal-workflow.test.ts # Proposal → approve/reject → restore/purge lifecycle
    delivery-api.test.ts      # Pagination, bbox, GeoJSON, filter, schema
    ingestion.test.ts         # Validate, import, governed, skipInvalid
    api-keys-auth.test.ts     # API Key scopes, auth middleware, bootstrap, revoke
    publish-metadata.test.ts  # Publish channels, field projection, DCAT metadata
examples/
  viewer/                     # Consumer demo app (Delivery API + MapLibre GL JS)
    index.html                # Dataset selector, schema-driven, 2D/3D toggle, bbox/near search
    README.md
  workbench/                  # Data quality workbench (Management API)
    index.html                # Dedup + Cleanse + Validate + Transform tools
    server.js                 # Backend proxy (manage scope key)
    README.md                 # How to run, API endpoints used
```

## Key Patterns

### Prisma + PostGIS
Geometry column is unconstrained `geometry` type (accepts both 2D and 3D, SRID 4326 enforced via CHECK). All geometry reads/writes go through `src/shared/geometry.ts` via `$queryRaw`/`$executeRaw`.

### 3D Geometry Support
`ModelDefinition.is3D` flag controls whether a model expects 2D or 3D geometry. 2D stores `[lon,lat]`, 3D stores `[lon,lat,z]`. No forced conversion — data stored as-is. CityJSON files can be imported via the Import Data page (frontend converts CityJSON boundaries to GeoJSON MultiPolygon with Z coordinates).

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

### Field Projection on Bindings
`DatasetModelBinding.projectionJson` controls which fields are exposed per dataset. Format: `{ mode: "include", fields: ["name","height"] }` or `{ mode: "exclude", fields: ["owner"] }`. Applied during snapshot generation (properties filtered before storing in manifest) and in Delivery schema endpoint. Allows same model to publish different field sets to different datasets (e.g. internal vs open data).

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

### Version Snapshot Geometry Patch
Geometry is stored in PostGIS via raw SQL, outside Prisma transactions. After `updateEntityInternal` completes, it patches the latest version snapshot with actual geometry from PostGIS. This prevents snapshots from losing geometry on status-only or properties-only updates.

### Error Handling
Custom `BusinessError` and `NotFoundError` classes (in `src/shared/errors.ts`) replace fragile string matching. Prisma errors are handled by code: P2002 → 409 (duplicate), P2025 → 404 (not found). Auto-approval failures are logged via `console.warn`.

### Entity Soft Delete and Purge
Delete action archives entities (status → archived). Archived entities are hidden from default views but preserved in the database. Admins can:
- **Restore** (`POST /entities/:id/restore`) — archived → active
- **Purge** (`DELETE /entities/:id/purge`) — permanent physical delete (only archived entities). Disconnects proposals (audit trail preserved), deletes versions, removes entity.

### CORS
All `/api/v1/*` routes have CORS enabled (`Access-Control-Allow-Origin: *`) for external tools (viewer, workbench). Configured in `src/app.ts` before route registration.

### Delivery API vs Management API
- **Management API** (`/api/v1/entities`, `/proposals`, etc.) — full read/write, all data including drafts/archived
- **Delivery API** (`/api/v1/delivery/`) — read-only, external consumers, only published data
- **Ingestion API** (`/api/v1/ingestion/`) — data pipelines, supports governed/direct/proposal modes

### Authentication: Dual-Track (JWT + API Key)
Two auth systems coexist in middleware:
1. **JWT (Keycloak)** — for human users (admin UI, browser). `Authorization: Bearer <token>`
2. **API Key** — for machine consumers (ETL, Viewer, CKAN). `X-API-Key: scms_xxx`
Middleware checks JWT first, then API Key. OGC API requires neither.

API Key scopes: `delivery` (read-only) < `manage` (read/write) < `admin` (full).
- `delivery`: Delivery API only
- `manage`: + Management API + Ingestion API + Definitions read (GET)
- `admin`: + Definitions write (POST/PUT/DELETE) + API Key management
Bootstrap: `POST /api-keys/bootstrap` creates first admin key without auth (only when no keys exist).
Env: `DELIVERY_API_KEY_REQUIRED=false` disables all auth checks (dev mode).

### Dataset Metadata (DCAT)
Dataset-level metadata for external consumers: description, license (SPDX), source, contactName, contactEmail, keywords. Managed in Publish → Dataset detail page. Exposed via:
- Delivery API `/datasets/:id` — metadata fields in response
- `/datasets/:id/metadata` — DCAT JSON-LD format (for CKAN, Google Dataset Search)
- OGC collections — include description and license

### Publish Channels
Each dataset controls which APIs expose its data:
- `publishToDelivery` (default true) — Delivery API
- `publishToOgc` (default false) — OGC API Features (for GIS tools, public)

### App Architecture (src/app.ts vs src/index.ts)
`src/app.ts` creates and exports the Express app (routes, middleware, error handler) without calling `listen()`. `src/index.ts` imports app and starts the server. This separation allows tests to import the app without starting a server. JSON body limit is 10MB (for large geometry imports).

## API Endpoints

### Content
- `GET /api/v1/entities` — list with query support:
  - `?type=building` — filter by model type
  - `?status=active` — filter by status (default view shows active only)
  - `?page=1&pageSize=100` — pagination (max 100000)
  - `?bbox=minLon,minLat,maxLon,maxLat` — bounding box spatial query
  - `?near=lon,lat&radius=meters` — proximity search
  - `?sort=createdAt:desc` — sort (createdAt, updatedAt, type, status)
- `GET /api/v1/entities/:id` — detail with geometry
- `GET /api/v1/entities/:id/versions` — version history
- `POST /api/v1/entities/:id/restore` — restore archived entity to active
- `DELETE /api/v1/entities/:id/purge` — permanently delete archived entity

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
- `GET /api/v1/delivery/datasets` — list published datasets (publishToDelivery=true)
- `GET /api/v1/delivery/datasets/:id` — dataset metadata (description, license, CRS, etc.)
- `GET /api/v1/delivery/datasets/:id/schema` — all model schemas
- `GET /api/v1/delivery/datasets/:id/metadata` — DCAT JSON-LD metadata (for catalogs)
- `GET /api/v1/delivery/datasets/:id/models` — list models in dataset
- `GET /api/v1/delivery/datasets/:id/models/:key/schema` — single model schema + CRS
- `GET /api/v1/delivery/datasets/:id/models/:key/entities` — entities by model type
- `GET /api/v1/delivery/datasets/:id/entities` — all entities with query support:
  - `?page=1&pageSize=100` — pagination (max 100000)
  - `?bbox=minLon,minLat,maxLon,maxLat` — bounding box spatial query
  - `?near=lon,lat&radius=meters` — proximity search
  - `?filter[field]=value` or `?filter[field][$gte]=100` — property filtering
  - `?sort=field:asc` — sorting
  - `?format=geojson` — GeoJSON FeatureCollection output
- `GET /api/v1/delivery/datasets/:id/entities/:entityId` — single entity

### OGC API - Features (standard-compliant, for GIS tools)
Each collection = one model from a publishToOgc=true dataset. Collection ID: `{datasetId}_{modelKey}`.
- `GET /api/v1/ogc/` — landing page
- `GET /api/v1/ogc/conformance` — conformance declaration
- `GET /api/v1/ogc/collections` — per-model collections from OGC-enabled datasets
- `GET /api/v1/ogc/collections/:collectionId` — collection metadata + CRS
- `GET /api/v1/ogc/collections/:collectionId/schema` — JSON Schema format
- `GET /api/v1/ogc/collections/:collectionId/items` — GeoJSON FeatureCollection (`?limit=`, `?offset=`, `?bbox=`)
- `GET /api/v1/ogc/collections/:collectionId/items/:featureId` — single GeoJSON Feature

## Frontend Pages (hash routes)

Organized by product workflow: **Define → Manage → Publish**

| Route | Section | Page |
|-------|---------|------|
| `#dashboard` | Manage | Dashboard: stats, activity, pending review |
| `#define/models` | Define | Model Designer list + create + governance columns |
| `#define/models/{id}` | Define | Fields, reference fields, governance policy |
| `#manage/records` | Manage | All records with search/filter |
| `#manage/records/{modelKey}` | Manage | Records filtered by model |
| `#manage/records/{modelKey}/{id}` | Manage | Entity detail + structured props + version history + edit |
| `#manage/new/{modelKey}` | Manage | Dynamic form → create proposal |
| `#manage/review` | Manage | Review queue + batch approve + history |
| `#manage/review/{id}` | Manage | Proposal detail + diff view + approve/reject |
| `#publish/datasets` | Publish | Dataset list + create |
| `#publish/datasets/{id}` | Publish | Bindings + field projection + snapshots + publish + history |
| `#publish/delivery` | Publish | Delivery API docs + inline preview |
| `#publish/ogc` | Publish | OGC Services docs + QGIS connection guide |
| `#integrate/import` | Integrate | File import (GeoJSON/CSV/CityJSON + field mapping) |
| `#integrate/api` | Integrate | Ingestion API docs + test data generator + validate/import |
| `#integrate/management` | Integrate | Management API docs + integration examples |
| `#dev/api` | Dev Only | Interactive API endpoint explorer |
| `#dev/console` | Dev Only | One-page publish workflow testing |

Old routes (`#content`, `#models`, `#proposals`, `#datasets`, `#publications`, `#api-playground`, `#publish-console`, `#integrate/ingestion`) auto-redirect to new paths.

## Ports

| Service | Port |
|---------|------|
| Express API + Frontend | 3001 |
| PostgreSQL + PostGIS | 5434 |
| Directus | 8055 |
| Keycloak | 8180 |

## Credentials

- **Directus**: admin@example.com / admin
- **PostgreSQL**: spatial_cms / spatial_cms / spatial_cms (user/pass/db)
- **Keycloak**: admin / admin (master realm admin)
- **CMS Users**: admin/admin, editor/editor, reviewer/reviewer (spatial-cms realm)
