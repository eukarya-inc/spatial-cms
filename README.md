# Spatial CMS

Spatial data governance control plane. Define models, manage entities through proposals, publish datasets via Delivery API and OGC API.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Docker](https://www.docker.com/) + Docker Compose

## Quick Start

```bash
# Clone and install
git clone https://github.com/eukarya-inc/spatial-cms.git
cd spatial-cms
npm install

# Configure environment
cp .env.example .env

# Start services (PostGIS, Keycloak, Directus)
docker compose up -d

# Wait for Keycloak to be ready (~20 seconds)
until curl -s http://localhost:8180/realms/spatial-cms > /dev/null 2>&1; do sleep 2; done

# Run database migrations
npx prisma migrate deploy
npm run db:migrate:test

# (Optional) Seed sample data — 1000 buildings in Tokyo Taito-ku
npx tsx scripts/seed-taito.ts

# Start the dev server
npm run dev
```

Open **http://localhost:3001** and log in with `admin` / `admin`.

## Services

| Service | Port | Credentials |
|---------|------|-------------|
| CMS (Express API + Admin UI) | 3001 | Keycloak login (see below) |
| PostgreSQL + PostGIS | 5434 | spatial_cms / spatial_cms |
| Keycloak (Auth) | 8180 | admin / admin (master realm) |
| Directus | 8055 | admin@example.com / admin |

### Keycloak Users (spatial-cms realm)

| Username | Password | Role | Access |
|----------|----------|------|--------|
| admin | admin | admin | Full access |
| editor | editor | editor | Create proposals, import data |
| reviewer | reviewer | reviewer | Review and approve proposals |

## Example Apps

### Viewer (Delivery API consumer)

```bash
cd examples/viewer
cp .env.example .env
# Edit .env: add a delivery-scope API Key
node server.js
# Open http://localhost:8090
```

### Data Workbench (Data quality tools)

```bash
cd examples/workbench
cp .env.example .env
# Edit .env: add a manage-scope API Key
node server.js
# Open http://localhost:8095
```

Generate API Keys at **http://localhost:3001/#integrate/api-keys** after logging in.

## Running Tests

```bash
npm test          # 47 integration tests
npm run test:watch
```

Tests use a separate database (`spatial_cms_test`) — dev data is not affected.

## API Overview

| API | Base Path | Auth | Purpose |
|-----|-----------|------|---------|
| Management | `/api/v1/entities`, `/proposals`, etc. | manage scope | Read/write all data |
| Ingestion | `/api/v1/ingestion/` | manage scope | Batch import |
| Delivery | `/api/v1/delivery/` | delivery scope | Read-only published data |
| OGC API | `/api/v1/ogc/` | Public | GIS tools (QGIS, ArcGIS) |
| Definitions | `/api/v1/definitions/` | GET: manage, write: admin | Model/field schema |
| API Keys | `/api/v1/api-keys/` | admin scope | Key management |

Authentication: **JWT (Keycloak)** for humans, **API Key** for machines (`X-API-Key` header).

## Production Deployment

```bash
cp .env.production.example .env.production
# Edit: set strong passwords and API keys
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml exec cms npx prisma migrate deploy
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Project Structure

```
src/                    # Express backend (TypeScript)
public/index.html       # Admin UI (single-page app)
prisma/schema.prisma    # Database schema
tests/                  # Integration tests
examples/
  viewer/               # Delivery API consumer (MapLibre GL JS)
  workbench/            # Data quality tools (Dedup + Cleanse)
docker/                 # Keycloak realm config, test DB init
```

## License

Private
