/**
 * Seed an LOD2-style building dataset into the `lod2-building` workspace
 * (display name: LOD２建築物モデル). Demonstrates CityGML / 3DCityDB-style
 * two-model decomposition:
 *
 *   building_lod2     — semantic target: name, function, year, address,
 *                       total_height_m, 2D footprint
 *   boundary_surface  — geometric carriers (wall / roof / ground), each with
 *                       its own 3D polygon + material + color, referencing
 *                       the parent Building by UUID
 *
 * Creates 3 buildings × (1 Building + 4 walls + 1 roof + 1 ground) = 21
 * entities total around Tokyo Station.
 *
 * Run: SEED_API_KEY=scms_xxx npx tsx scripts/seed-lod2-buildings.ts
 *
 * Auth: existing admin-scope key via SEED_API_KEY, or bootstrap (only when
 * zero keys exist).
 */
import "dotenv/config";

const API_BASE = `http://localhost:${process.env.PORT || 3001}/api/v1`;
const WORKSPACE = process.env.SEED_WORKSPACE || "lod2-building";
let API_KEY: string | null = null;

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Workspace-Key": WORKSPACE,
  };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers as any) } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function ensureAuth() {
  const status = (await api<{ required: boolean }>("/api-keys/status")).required;
  if (!status) {
    console.log("  Auth disabled. Proceeding without API key.");
    return;
  }
  if (process.env.SEED_API_KEY) {
    API_KEY = process.env.SEED_API_KEY;
    console.log("  Using SEED_API_KEY from env.");
    return;
  }
  const boot = await fetch(`${API_BASE}/api-keys/bootstrap`, { method: "POST" });
  if (boot.ok) {
    const json = (await boot.json()) as { key: string };
    API_KEY = json.key;
    console.log(`  Bootstrapped admin API key: ${API_KEY!.slice(0, 12)}…`);
    return;
  }
  throw new Error(
    "Auth required but no key. Set SEED_API_KEY=scms_xxx (admin scope) or delete all existing keys for bootstrap.",
  );
}

// ─── Geometry helpers ─────────────────────────────────────────────────

const STATION = { lon: 139.7671, lat: 35.6812 };
const M_PER_DEG_LAT = 111_000;
const M_PER_DEG_LON = 90_650;

function offsetCenter(dLonM: number, dLatM: number) {
  return {
    lon: STATION.lon + dLonM / M_PER_DEG_LON,
    lat: STATION.lat + dLatM / M_PER_DEG_LAT,
  };
}

/** 2D footprint polygon — for Building's 2D mode field. */
function rect2D(center: { lon: number; lat: number }, widthM: number, depthM: number) {
  const dLon = widthM / 2 / M_PER_DEG_LON;
  const dLat = depthM / 2 / M_PER_DEG_LAT;
  // SW, SE, NE, NW, close
  return {
    type: "Polygon",
    coordinates: [[
      [center.lon - dLon, center.lat - dLat],
      [center.lon + dLon, center.lat - dLat],
      [center.lon + dLon, center.lat + dLat],
      [center.lon - dLon, center.lat + dLat],
      [center.lon - dLon, center.lat - dLat],
    ]],
  };
}

/** 3D vertical wall as a closed polygon ring between two base corners. */
function wall3D(p1: [number, number], p2: [number, number], heightM: number) {
  return {
    type: "Polygon",
    coordinates: [[
      [p1[0], p1[1], 0],
      [p2[0], p2[1], 0],
      [p2[0], p2[1], heightM],
      [p1[0], p1[1], heightM],
      [p1[0], p1[1], 0],
    ]],
  };
}

/** 3D horizontal polygon at fixed Z (used for roof and ground). */
function flat3D(center: { lon: number; lat: number }, widthM: number, depthM: number, z: number) {
  const dLon = widthM / 2 / M_PER_DEG_LON;
  const dLat = depthM / 2 / M_PER_DEG_LAT;
  return {
    type: "Polygon",
    coordinates: [[
      [center.lon - dLon, center.lat - dLat, z],
      [center.lon + dLon, center.lat - dLat, z],
      [center.lon + dLon, center.lat + dLat, z],
      [center.lon - dLon, center.lat + dLat, z],
      [center.lon - dLon, center.lat - dLat, z],
    ]],
  };
}

/** Return the 4 corner [lon, lat] points of a footprint, in SW/SE/NE/NW order. */
function corners(center: { lon: number; lat: number }, widthM: number, depthM: number): [
  [number, number], [number, number], [number, number], [number, number]
] {
  const dLon = widthM / 2 / M_PER_DEG_LON;
  const dLat = depthM / 2 / M_PER_DEG_LAT;
  return [
    [center.lon - dLon, center.lat - dLat], // SW
    [center.lon + dLon, center.lat - dLat], // SE
    [center.lon + dLon, center.lat + dLat], // NE
    [center.lon - dLon, center.lat + dLat], // NW
  ];
}

// ─── Building specs (CityGML-aligned) ─────────────────────────────────

interface BuildingSpec {
  name: string;
  off: [number, number]; // dLon-m, dLat-m from Tokyo Station
  w: number;
  d: number;
  h: number;
  function: "residential" | "commercial" | "industrial" | "institutional" | "other";
  class: "normal" | "arcade" | "monumental" | "small";
  roofType: "flat" | "shed" | "gable" | "hip" | "pyramid" | "mansard" | "dome";
  storeysAbove: number;
  year: number;
  creationDate: string; // ISO date (CityGML core:creationDate)
  address: string;
  wallMaterial: string;
  wallColor: string;
  roofMaterial: string;
  roofColor: string;
  groundMaterial: string;
  groundColor: string;
}

const BUILDINGS: BuildingSpec[] = [
  {
    name: "Main Hall",
    off: [-80, 0],
    w: 20, d: 10, h: 8,
    function: "commercial", class: "normal", roofType: "flat", storeysAbove: 2,
    year: 1998, creationDate: "1998-04-01",
    address: "東京都千代田区丸の内1丁目",
    wallMaterial: "concrete",  wallColor:  "#9ca3af",
    roofMaterial: "tile",      roofColor:  "#b91c1c",
    groundMaterial: "concrete", groundColor: "#6b7280",
  },
  {
    name: "Glass Tower",
    off: [80, 60],
    w: 12, d: 12, h: 20,
    function: "commercial", class: "normal", roofType: "flat", storeysAbove: 6,
    year: 2012, creationDate: "2012-09-15",
    address: "東京都千代田区丸の内2丁目",
    wallMaterial: "glass",     wallColor:  "#60a5fa",
    roofMaterial: "gravel",    roofColor:  "#6b7280",
    groundMaterial: "concrete", groundColor: "#6b7280",
  },
  {
    name: "Wooden Pavilion",
    off: [0, -80],
    w: 8, d: 8, h: 4,
    function: "institutional", class: "small", roofType: "hip", storeysAbove: 1,
    year: 1985, creationDate: "1985-06-20",
    address: "東京都千代田区丸の内3丁目",
    wallMaterial: "wood",      wallColor:  "#92400e",
    roofMaterial: "slate",     roofColor:  "#374151",
    groundMaterial: "dirt",    groundColor: "#78350f",
  },
];

// GML ID helpers — CityGML-style human-readable identifiers
const bldgGmlId = (seq: number) => `BLDG_${String(seq).padStart(3, "0")}`;
const wallGmlId = (seq: number, dir: string) => `WALL_${String(seq).padStart(3, "0")}_${dir}`;
const roofGmlId = (seq: number) => `ROOF_${String(seq).padStart(3, "0")}`;
const groundGmlId = (seq: number) => `GROUND_${String(seq).padStart(3, "0")}`;

console.log(`Plan: ${BUILDINGS.length} buildings × 6 surfaces = ${BUILDINGS.length + BUILDINGS.length * 6} entities into workspace "${WORKSPACE}"\n`);

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const resetFlag = process.argv.includes("--reset") || process.env.SEED_RESET === "1";

  console.log("Step 0: Auth + workspace check…");
  await ensureAuth();
  // Confirm workspace exists (api() always sends X-Workspace-Key, default fallback would hide a typo)
  const wsList = await api<Array<{ slug: string; name: string }>>("/workspaces");
  const ws = wsList.find((w) => w.slug === WORKSPACE);
  if (!ws) {
    throw new Error(
      `Workspace slug "${WORKSPACE}" not found. Existing: ${wsList.map((w) => w.slug).join(", ")}. ` +
        `Create it via the CMS UI (workspace switcher → New Workspace) and re-run.`,
    );
  }
  console.log(`  Using workspace: ${ws.slug} (${ws.name})`);

  // ─── Step 1: building_lod2 model ────────────────────────────────────
  const existingModels = await api<Array<{ id: string; key: string }>>("/definitions/models");
  const targetKeys = ["building_lod2", "boundary_surface"];
  const collisions = existingModels.filter((m) => targetKeys.includes(m.key));
  if (collisions.length) {
    if (resetFlag) {
      console.log(`\nStep 0.5: --reset → cascade-deleting ${collisions.length} existing model(s): ${collisions.map((m) => m.key).join(", ")}`);
      // Delete in reverse dependency order: boundary_surface first (it references building_lod2)
      const ordered = [...collisions].sort((a, b) => (a.key === "building_lod2" ? 1 : -1));
      for (const m of ordered) {
        await api(`/definitions/models/${m.id}`, { method: "DELETE" });
        console.log(`  ✗ deleted ${m.key} (${m.id.slice(0, 8)}…)`);
      }
    } else {
      throw new Error(
        `Models already exist in "${WORKSPACE}": ${collisions.map((m) => m.key).join(", ")}. ` +
          `Re-run with --reset to cascade-delete them and start fresh, or delete via the CMS UI.`,
      );
    }
  }

  console.log("\nStep 1: Create building_lod2 (semantic) model…");
  const bldgModel = await api<{ id: string; key: string }>("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "building_lod2",
      name: "LOD2 Building",
      description: "Semantic building anchor — CityGML/3DCityDB style. Properties live here; 3D geometry lives on the linked BoundarySurfaces.",
      primaryGeometryField: "footprint",
      displayField: "name",
    }),
  });
  console.log(`  → ${bldgModel.id}`);

  console.log("  Adding fields (CityGML-aligned: gml_id, class, roof_type, measured_height, etc.)…");
  await api(`/definitions/models/${bldgModel.id}/fields`, {
    method: "POST",
    body: JSON.stringify([
      // CityGML identity + classification
      { key: "gml_id",         label: "GML ID",       fieldType: "string", isRequired: true, orderIndex: 0 },
      { key: "name",           label: "Name",         fieldType: "string", isRequired: true, orderIndex: 1 },
      {
        key: "class", label: "Class (bldg:class)", fieldType: "enum_",
        enumValues: ["normal", "arcade", "monumental", "small"],
        orderIndex: 2,
      },
      {
        key: "function", label: "Function (bldg:function)", fieldType: "enum_",
        enumValues: ["residential", "commercial", "industrial", "institutional", "other"],
        orderIndex: 3,
      },
      {
        key: "roof_type", label: "Roof Type (bldg:roofType)", fieldType: "enum_",
        enumValues: ["flat", "shed", "gable", "hip", "pyramid", "mansard", "dome"],
        orderIndex: 4,
      },
      // Geometry-summary attributes (per CityGML 2.0 bldg module)
      { key: "measured_height",      label: "Measured Height (m)",  fieldType: "number", validationJson: { min: 0 }, orderIndex: 5 },
      { key: "storeys_above_ground", label: "Storeys Above Ground", fieldType: "number", validationJson: { min: 0 }, orderIndex: 6 },
      // Lifecycle + provenance
      { key: "year_built",     label: "Year Built",      fieldType: "number", validationJson: { min: 0 }, orderIndex: 7 },
      { key: "creation_date",  label: "Creation Date",   fieldType: "date",   orderIndex: 8 },
      { key: "address",        label: "Address",         fieldType: "string", orderIndex: 9 },
      // 2D footprint last (placed-after-rest is a 2.5D habit; 2D doesn't need it but stays consistent)
      {
        key: "footprint",
        label: "Footprint",
        fieldType: "geometry",
        geometryType: "POLYGON",
        geometrySrid: 4326,
        geometryMode: "2D",
        isRequired: true,
        orderIndex: 10,
      },
    ]),
  });

  console.log("  Setting governance to auto-approval…");
  await api("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: bldgModel.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });

  // ─── Step 2: boundary_surface model ─────────────────────────────────
  console.log("\nStep 2: Create boundary_surface (geometric) model…");
  const surfModel = await api<{ id: string; key: string }>("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "boundary_surface",
      name: "Boundary Surface (LOD2)",
      description: "Wall / roof / ground polygon with material; references its parent LOD2 Building. 3D mode — vertex Z required.",
      primaryGeometryField: "geometry",
      displayField: "surface_type",
    }),
  });
  console.log(`  → ${surfModel.id}`);

  console.log("  Adding fields (gml_id + parent_gml_id for CityGML traceability)…");
  await api(`/definitions/models/${surfModel.id}/fields`, {
    method: "POST",
    body: JSON.stringify([
      // Identity (CityGML)
      { key: "gml_id",        label: "GML ID",        fieldType: "string", isRequired: true, orderIndex: 0 },
      { key: "parent_gml_id", label: "Parent GML ID", fieldType: "string", isRequired: true, orderIndex: 1 },
      // Strong FK (keeps CMS-native queries efficient; coexists with parent_gml_id)
      { key: "building_id", label: "Building", fieldType: "reference", referenceModelKey: "building_lod2", isRequired: true, orderIndex: 2 },
      {
        key: "surface_type", label: "Surface Type (bldg:BoundarySurface subtype)", fieldType: "enum_",
        enumValues: ["wall", "roof", "ground"], isRequired: true, orderIndex: 3,
      },
      { key: "material",       label: "Material",       fieldType: "string", orderIndex: 4 },
      { key: "material_color", label: "Material Color", fieldType: "string", orderIndex: 5 },
      { key: "area_sqm",       label: "Area (sqm)",     fieldType: "number", validationJson: { min: 0 }, orderIndex: 6 },
      {
        key: "geometry",
        label: "Surface Geometry",
        fieldType: "geometry",
        geometryType: "POLYGON",
        geometrySrid: 4326,
        geometryMode: "3D",
        isRequired: true,
        orderIndex: 7,
      },
    ]),
  });

  console.log("  Setting governance to auto-approval…");
  await api("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: surfModel.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });

  // ─── Step 3: Create entities ────────────────────────────────────────
  console.log("\nStep 3: Creating buildings and their surfaces via proposals (auto-approved)…");

  let bldgCount = 0;
  let surfCount = 0;

  for (let i = 0; i < BUILDINGS.length; i++) {
    const b = BUILDINGS[i];
    const bldgSeq = i + 1;
    const bGmlId = bldgGmlId(bldgSeq);
    const center = offsetCenter(b.off[0], b.off[1]);
    const footprint = rect2D(center, b.w, b.d);
    const fpCorners = corners(center, b.w, b.d);

    // Create Building (auto-approved by governance, but the create-proposal endpoint
    // doesn't echo the created entity back. Query by gml_id to find it afterwards.)
    await api("/proposals", {
      method: "POST",
      body: JSON.stringify({
        proposedChange: {
          action: "create",
          data: {
            type: "building_lod2",
            properties: {
              gml_id: bGmlId,
              name: b.name,
              class: b.class,
              function: b.function,
              roof_type: b.roofType,
              measured_height: b.h,
              storeys_above_ground: b.storeysAbove,
              year_built: b.year,
              creation_date: b.creationDate,
              address: b.address,
              footprint,
            },
          },
        },
      }),
    });
    // Look up the just-created entity by gml_id (loop is serial → no race).
    const listed = await api<{ entities: Array<{ id: string; properties: Record<string, unknown> }> }>(
      `/entities?type=building_lod2&sort=createdAt:desc&pageSize=5`,
    );
    const match = listed.entities.find((e) => e.properties?.gml_id === bGmlId);
    const buildingId = match?.id;
    if (!buildingId) throw new Error(`Building "${b.name}" (${bGmlId}) was created but not found in subsequent list query`);
    bldgCount++;
    console.log(`  ✓ Building ${bGmlId} "${b.name}" — ${buildingId.slice(0, 8)}…`);

    // Walls (4): N (NW-NE), E (NE-SE), S (SE-SW), W (SW-NW)
    const [sw, se, ne, nw] = fpCorners;
    const wallArea = (len: number) => len * b.h;
    const wallLenLR = b.w;  // E-W edges
    const wallLenTB = b.d;  // N-S edges
    const wallSpecs: Array<{ name: string; geom: object; area: number }> = [
      { name: "N", geom: wall3D(nw, ne, b.h), area: wallArea(wallLenLR) },
      { name: "E", geom: wall3D(ne, se, b.h), area: wallArea(wallLenTB) },
      { name: "S", geom: wall3D(se, sw, b.h), area: wallArea(wallLenLR) },
      { name: "W", geom: wall3D(sw, nw, b.h), area: wallArea(wallLenTB) },
    ];

    for (const w of wallSpecs) {
      await api("/proposals", {
        method: "POST",
        body: JSON.stringify({
          proposedChange: {
            action: "create",
            data: {
              type: "boundary_surface",
              properties: {
                gml_id: wallGmlId(bldgSeq, w.name),
                parent_gml_id: bGmlId,
                building_id: buildingId,
                surface_type: "wall",
                material: b.wallMaterial,
                material_color: b.wallColor,
                area_sqm: Math.round(w.area),
                geometry: w.geom,
              },
            },
          },
        }),
      });
      surfCount++;
    }

    // Roof
    await api("/proposals", {
      method: "POST",
      body: JSON.stringify({
        proposedChange: {
          action: "create",
          data: {
            type: "boundary_surface",
            properties: {
              gml_id: roofGmlId(bldgSeq),
              parent_gml_id: bGmlId,
              building_id: buildingId,
              surface_type: "roof",
              material: b.roofMaterial,
              material_color: b.roofColor,
              area_sqm: Math.round(b.w * b.d),
              geometry: flat3D(center, b.w, b.d, b.h),
            },
          },
        },
      }),
    });
    surfCount++;

    // Ground
    await api("/proposals", {
      method: "POST",
      body: JSON.stringify({
        proposedChange: {
          action: "create",
          data: {
            type: "boundary_surface",
            properties: {
              gml_id: groundGmlId(bldgSeq),
              parent_gml_id: bGmlId,
              building_id: buildingId,
              surface_type: "ground",
              material: b.groundMaterial,
              material_color: b.groundColor,
              area_sqm: Math.round(b.w * b.d),
              geometry: flat3D(center, b.w, b.d, 0),
            },
          },
        },
      }),
    });
    surfCount++;

    console.log(`    + 6 surfaces (4 walls / roof / ground)`);
  }

  console.log("\n──────────────────────────────────────────────────");
  console.log(`Done. Created ${bldgCount} buildings × 6 surfaces = ${bldgCount + surfCount} entities total.`);
  console.log(`\nNext steps:`);
  console.log(`  • Switch the CMS Admin to workspace "${ws.name}" (slug: ${ws.slug})`);
  console.log(`  • Open Define → Models → see building_lod2 (POLYGON 2D) + boundary_surface (POLYGON 3D)`);
  console.log(`  • Open any Building's detail → footprint renders flat`);
  console.log(`  • Open any Boundary Surface's detail → surface renders as 3D fill-extrusion (Z preserved)`);
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err.message || err);
  process.exit(1);
});
