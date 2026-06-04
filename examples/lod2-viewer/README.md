# LOD2 Viewer — Spatial CMS Example

## Why This Exists

The Spatial CMS LOD2 schema decomposes a building into **two entity types**:

- `building_lod2` — semantic anchor: gml_id, measured_height, storeys, class,
  usage, **2D footprint**
- `boundary_surface` — wall / roof / ground polygons, each with its own
  **3D geometry**; linked to the parent via a `building_id` reference field

This sample exists to show consumer applications **how to assemble those two
back into a complete 3D building** by following the reference, using only the
read-only **Delivery API**.

```
         building_lod2  ──┐
                         │ (1 entity)
                         ▼
              [ assembled 3D building ]
                         ▲
                         │ (N entities — typically 6 to 100)
         boundary_surface ──┘
              (filter by building_id reference)
```

It is **not** part of the CMS product — it's a reference for app developers /
your customers who want to consume the data.

## The Two-Step Fetch Pattern

When the user picks a building from the list, this sample issues exactly
**two** Delivery API calls:

```
1. GET /api/v1/delivery/datasets/<dsId>/entities/<buildingId>
2. GET /api/v1/delivery/datasets/<dsId>/entities?modelKey=boundary_surface
                                                &filter[building_id]=<buildingId>
                                                &pageSize=500
```

That's the whole assembly mechanism: **one entity fetch + one filtered list**.
The Delivery API supports `filter[<field>]=<value>` against any property,
including UUID reference fields. Both calls are visible in the bottom "API
Log" panel of the UI.

After the two calls, the sample groups surfaces by `surface_type`
(wall / roof / ground), normalizes each building's Z values to a per-building
ground baseline (PLATEAU stores absolute altitude), and renders each group as
a deck.gl `SolidPolygonLayer` (fill) + `PathLayer` (3D edges).

## Architecture

```
Browser (index.html, port 8091)
   │  /api/datasets/...                (no API key exposed)
   ▼
Proxy (server.js)
   │  X-API-Key + X-Workspace-Key      (from .env)
   ▼
Spatial CMS Delivery API (port 3001)
```

The proxy pattern keeps the API key in the backend env, never in the
browser. Same as the other `examples/viewer/`.

## Prerequisites

PLATEAU LOD2 data needs to be loaded **and published**:

1. Run `scripts/seed-plateau-taito-lod2.ts` (one-time, see the script's
   header comment) — this populates the `plateau-taito-lod2` workspace
   with 30 building_lod2 + 549 boundary_surface entities.

2. In the CMS Admin UI:
   - Switch to the `plateau-taito-lod2` workspace (workspace switcher,
     top-left)
   - Go to `Publish → Datasets → + New Dataset` → name "Taito LOD2" →
     bind **both** `building_lod2` and `boundary_surface` → Create
   - Open the new dataset → click "Generate snapshot" → wait → click
     "Publish"
   - Go to `Integrate → API Keys → Generate New Key` → scope: `delivery`
     → copy the key

## How to Run

```bash
cd examples/lod2-viewer
cp .env.example .env
# Edit .env:
#   CMS_API_KEY    → the delivery-scope key from the step above
#   CMS_WORKSPACE  → plateau-taito-lod2
node server.js
```

Then open <http://localhost:8091>.

## Configuration (.env)

```
CMS_URL=http://localhost:3001/api/v1       # CMS Delivery API base
CMS_API_KEY=scms_your_delivery_key_here    # delivery-scope key
CMS_WORKSPACE=plateau-taito-lod2           # workspace the key is bound to
PORT=8091                                  # this sample's port
```

**Workspace binding**: API keys are strictly workspace-scoped — `CMS_WORKSPACE`
must match the workspace the key was generated in, otherwise every request
returns `403 API key is bound to a different workspace`.

## Color Convention

| Surface type | Color    | Note                                       |
|--------------|----------|---------------------------------------------|
| `wall`       | `#9ca3af` (gray) | Each entity's `material_color` overrides if set |
| `roof`       | `#b91c1c` (red)  | Same                                            |
| `ground`     | `#6b7280` (gray) | Same                                            |
| Footprint    | translucent slate | The building's 2D footprint as a ground reference |

## Reading the Code

Two sections in `index.html` carry the educational weight:

- **`selectBuilding(buildingId)`** — the two-step fetch. Read this top to bottom;
  it's the canonical assembly pattern.
- **`renderBuilding3D(building, surfaces)`** — Z normalization + grouping by
  surface_type + deck.gl layer assembly. Pattern reusable for any 1-parent +
  N-child model decomposition.

## Limits

- One building at a time (intentional — focuses on the assembly pattern,
  not on rendering a whole city).
- No textures (PLATEAU's appearance/texture data is ignored; flat material
  colors only).
- No edit mode (consumer-only).
- No OGC tile path (Delivery API is enough).
