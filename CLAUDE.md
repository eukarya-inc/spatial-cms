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
# 1. Install dependencies
npm install

# 2. Start all services (Docker + Express + examples)
./dev.sh start                 # Interactive: just run ./dev.sh

# 3. Run database migrations (first time only)
npx prisma migrate deploy
npm run db:migrate:test        # Test database

# 4. (Optional) Seed sample data
npx tsx scripts/seed-taito.ts

# 5. Open http://localhost:3001
#    Login: admin / admin (Keycloak)
```

Run tests: `npm test` (61 integration tests)

### Dev Service Manager (`dev.sh`)

Interactive TUI or CLI for managing all services:

```bash
./dev.sh                       # Interactive mode (press keys to control)
./dev.sh start [service]       # Start all or one service
./dev.sh stop [service]        # Stop all or one service
./dev.sh restart [service]     # Restart all or one service
./dev.sh status                # Show status table
./dev.sh logs <service>        # Tail logs
./dev.sh deploy-prod         # Deploy master → AWS production
./dev.sh prod-status         # Check production health
./dev.sh prod-logs [service] # Tail production logs (default: cms)
```

Services: `db` `keycloak` `directus` `cms` `viewer` `workbench`

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
    template/                 # Bundled template gallery + apply (models only, no dataset)
    api-keys/                 # API Key CRUD, bootstrap, scope management
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
    multi-geometry.test.ts    # Multi-geometry fields, primaryGeometryField, field reorder
    workspace-crud.test.ts    # Workspace rename (PATCH /workspaces/:slug)
examples/
  viewer/                     # Consumer demo app (Delivery API + MapLibre GL JS)
    index.html                # Dataset selector, schema-driven, 2D/3D toggle, bbox/near search
    README.md
  workbench/                  # Data quality workbench (Management API)
    index.html                # Dedup + Cleanse + Compute (derived geometry) tools
    server.js                 # Backend proxy (manage scope key)
    README.md                 # How to run, API endpoints used
dev.sh                        # Dev service manager (interactive TUI + CLI)
deploy/                       # AWS deployment kit (single-tenant, per-team)
  README.md                   # Step-by-step deployment guide (Lightsail VM + RDS)
  docker-compose.deploy.yml   # Production compose (cms + keycloak + caddy only)
  Caddyfile                   # Reverse proxy with auto Let's Encrypt HTTPS
  .env.example                # Environment variables template
  scripts/setup-rds.sh        # RDS init (create DBs, enable PostGIS)
  scripts/deploy.sh           # One-command VM deploy/update
```

## Key Patterns

### Workspaces (intra-deployment grouping)
Every `ModelDefinition` and `DatasetDefinition` belongs to a `Workspace` (via FK).
Everything below them (fields, entities, proposals, snapshots, publications,
governance policies, bindings) inherits the workspace transitively through its
parent. There is a single bootstrap workspace `default` created by migration,
which is where all pre-workspace data lives.

Requests to Management/Ingestion/Definitions/Template APIs are scoped via the
`X-Workspace-Key: <slug>` header (or `?workspace=<slug>` query). Missing /
unknown header falls back to `default` — this is why existing tests, seed
scripts, and external API clients keep working without changes.

Delivery API and OGC API are **workspace-agnostic** (datasets are
globally-unique by id; consumers don't need to know about workspaces). API keys
are also workspace-agnostic for MVP — every key sees every workspace.

Frontend keeps the current workspace in `window.currentWorkspaceSlug` (persisted
to `localStorage['workspace_slug']`); the `api()` helper auto-attaches the
header. Switching workspaces clears caches and re-renders the current view.

Model keys are unique **per workspace** (not globally) — the same `building`
key can exist in workspace A and workspace B. `findModelDefinitionByKey` takes
`workspaceId` as the first argument. Dataset names follow the same pattern.

### Prisma + PostGIS
Geometry is stored in a separate `entity_geometry` table (not on the entity table). Each geometry field value gets its own row with a GIST spatial index, enabling spatial queries on any geometry field. The entity table's `properties` JSONB stores non-geometry field values only; geometry is merged back into properties at read time. All geometry reads/writes go through `src/shared/geometry.ts` via `$queryRaw`/`$executeRaw`.

### Geometry as a Field Type
Geometry is a FieldDefinition type (`fieldType: "geometry"`), not a model-level property. Each geometry field has its own `geometryType` (POINT/POLYGON/etc.), `geometrySrid`, and `geometryIs3D`. A model can have 0, 1, or many geometry fields. `ModelDefinition.primaryGeometryField` points to the field key used for spatial indexing and GeoJSON output. Geometry values are stored in `properties` alongside regular fields — no separate top-level `geometry` on entities or proposals.

### Geometry Map UI (frontend)
Each geometry field renders as an inline `.geometry-card` with a MapLibre GL preview/editor. Reusable component `renderGeometryCard({field, value, mode, isPrimary, containerEl, onChange, entityProperties})` in `public/index.html` handles both view (read-only) and edit (Mapbox Draw integration) modes. MapLibre + Mapbox Draw are CDN-loaded lazily on first card mount via `loadMapLibs()`. Rules:
- SRID 4326 only — non-4326 fields show a warning banner and JSON-only editor
- **View mode does 2.5D fill-extrusion** for polygons when a height value is present. Height priority: `entityProperties.height_m` → `height` → `measured_height` → max Z from vertex coordinates. When the height is > 0, the layer hides the flat fill and sets pitch=45°/bearing=-20°.
- 3D geometries: edit mode confirms before discarding Z; JSON textarea is the lossless fallback for Z editing
- Map ↔ JSON textarea bidirectional sync (textarea synced on map draw events; map updated on textarea blur with valid-JSON check)
- `router()` calls `__cleanupGeometryCards()` to prevent WebGL context leaks on navigation
- Use cases: `viewEntityDetail` (mode `'view'`, passes `entityProperties`), edit form inside detail (mode `'edit'`), `viewNewRecord` (mode `'edit'`)

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

### Validation Timing
For `action: create` proposals, `validateAgainstModel()` runs at **proposal-create time** (not just approve time). An invalid create payload returns 400 before any row is inserted, so the review queue never holds structurally invalid proposals. Update/delete proposals validate only at approve time (partial payloads are allowed).

### Field Immutability
Once a `FieldDefinition` is created, only `label`, `isRequired`, and `enumValues` (for enum_ fields) can be edited. Everything else — `key`, `fieldType`, `validationJson` (pattern/length/range), `defaultValue`, `referenceModelKey`, `geometryType`/`Srid`/`Is3D` — is immutable. To change them, delete the field and recreate it. The Model Designer surfaces all constraints in a "Schema constraints (immutable)" read-only summary inside the inline edit panel.

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

### Version Snapshot Geometry
Snapshots store all data in `{ type, properties }` format. Geometry values are inside properties (e.g. `properties.location`). The PostGIS column is synced separately after entity create/update by extracting the `primaryGeometryField` value from properties.

### Error Handling
Custom `BusinessError` and `NotFoundError` classes (in `src/shared/errors.ts`) replace fragile string matching. Prisma errors are handled by code: P2002 → 409 (duplicate), P2025 → 404 (not found). Auto-approval failures are logged via `console.warn`.

### Entity Soft Delete and Purge
Delete action archives entities (status → archived). Archived entities are hidden from default views but preserved in the database. Admins can:
- **Restore** (`POST /entities/:id/restore`) — archived → active
- **Purge** (`DELETE /entities/:id/purge`) — permanent physical delete (only archived entities). Disconnects proposals (audit trail preserved), deletes versions, removes entity.

### Model Templates
Templates only create models + fields (Definition Kernel). They do NOT create datasets (Publish Kernel). Template JSON files may include a `dataset` section as a recommended configuration hint, but `applyTemplate` ignores it — dataset creation is a publish decision the user must make explicitly. Apply uses `$transaction` for atomicity. GET endpoints require `manage` scope; POST /apply requires `admin`.

**Bundled templates are synced from the community repo [`lavalse/spatial-cms-model-template`](https://github.com/lavalse/spatial-cms-model-template)**. The CMS bundles 11 templates across 5 categories (general / plateau / osm / municipal / gif). Files live in `src/templates/` with flat `<category>-<basename>.json` naming so the non-recursive `listBundledTemplates()` discovers them. To resync after the upstream repo updates: replace files in `src/templates/` from `https://raw.githubusercontent.com/lavalse/spatial-cms-model-template/main/templates/<category>/<file>.json` (no backend changes needed).

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
- `manage`: + Management API + Ingestion API + Definitions read (GET) + Templates browse/preview
- `admin`: + Definitions write (POST/PUT/DELETE) + Template apply + API Key management
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
- `CRUD /api/v1/definitions/models` — model definitions (primaryGeometryField, displayField)
- `CRUD /api/v1/definitions/models/:id/fields` — field definitions (geometry fields have geometryType/geometrySrid/geometryIs3D)
- `PUT /api/v1/definitions/models/:id/fields/reorder` — batch reorder fields (`{ order: ["key1", "key2", ...] }`)
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

### Templates
- `GET /api/v1/templates` — list bundled templates (metadata only, manage scope)
- `GET /api/v1/templates/:id` — get full template content (manage scope)
- `POST /api/v1/templates/resolve` — fetch + validate from URL or inline JSON (manage scope)
- `POST /api/v1/templates/apply` — apply template: creates models + fields only, no dataset (admin scope)

### Workspaces
- `GET /api/v1/workspaces` — list all workspaces (manage scope)
- `GET /api/v1/workspaces/:slug` — workspace detail
- `POST /api/v1/workspaces` — create (admin scope)
- `PATCH /api/v1/workspaces/:slug` — rename name and/or description (admin scope; `slug` is immutable)
- `DELETE /api/v1/workspaces/:slug` — cascade delete; refuses `default` (admin scope)
- `GET /api/v1/workspaces/locate/{entity|model|dataset}/:id` — find which workspace owns a record; used by the UI to recover from cross-workspace 404s on detail pages

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

**Consumer apps** (e.g. `examples/viewer`) compute extrusion height for 3D rendering using this priority: `properties.height_m` → `properties.height` → `properties.measured_height` → max Z extracted from polygon vertex coordinates. Z is preserved through `ST_AsGeoJSON` so `geometryIs3D: true` fields keep their Z values in the output.

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
| `#define/templates` | Define | Template Gallery: search, preview, apply (models only) |
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
| `#dev/api` | Dev Only | Interactive API endpoint explorer (dev env only) |
| `#dev/console` | Dev Only | One-page publish workflow testing (dev env only) |

**Dev-Only routes are gated by environment**: the sidebar section `#dev-section` is hidden unless `NODE_ENV !== "production"`, and the router redirects `#dev/*` routes to `#dashboard` in production. Backend signals environment via `GET /api/v1/auth/config` → `{ isDevelopment }`. To set production mode, set `NODE_ENV=production` (done automatically in `deploy/docker-compose.deploy.yml`).

Old routes (`#content`, `#models`, `#proposals`, `#datasets`, `#publications`, `#api-playground`, `#publish-console`, `#integrate/ingestion`) auto-redirect to new paths.

## Ports

| Service | Port |
|---------|------|
| Express API + Frontend | 3001 |
| PostgreSQL + PostGIS | 5434 |
| Directus | 8055 |
| Keycloak | 8180 |
| Viewer Example | 8090 |
| Workbench Example | 8095 |

## Credentials

- **Directus**: admin@example.com / admin
- **PostgreSQL**: spatial_cms / spatial_cms / spatial_cms (user/pass/db)
- **Keycloak**: admin / admin (master realm admin)
- **CMS Users**: admin/admin, editor/editor, reviewer/reviewer (spatial-cms realm)
