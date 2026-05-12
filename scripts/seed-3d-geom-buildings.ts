/**
 * Seed ~20 buildings whose footprint geometry is true 3D (per-vertex Z coords),
 * with NO height_m attribute. Forces the viewer's extractMaxZ path so we
 * exercise the geometryIs3D=true end-to-end data flow.
 *
 * 15 uniform-Z (flat-top), 5 varied-Z (sloped roof — exposes MapLibre limit).
 *
 * Run: SEED_API_KEY=scms_xxx npx tsx scripts/seed-3d-geom-buildings.ts
 *
 * If no SEED_API_KEY: tries bootstrap (only works when zero keys exist).
 */
import "dotenv/config";

const API_BASE = `http://localhost:${process.env.PORT || 3001}/api/v1`;
let API_KEY: string | null = null;

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
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
    "Auth required but no API key. Pass SEED_API_KEY=scms_xxx (admin scope) or delete all existing keys for bootstrap.",
  );
}

// ─── Geometry helpers ──────────────────────────────────────────────

const STATION = { lon: 139.7671, lat: 35.6812 };
const NORTH_OFFSET_M = 500; // shift this whole dataset 500m north of `building` dataset
const M_PER_DEG_LAT = 111_000;
const M_PER_DEG_LON = 90_650;

function offsetCenter(dLonM: number, dLatM: number) {
  return {
    lon: STATION.lon + dLonM / M_PER_DEG_LON,
    lat: STATION.lat + (dLatM + NORTH_OFFSET_M) / M_PER_DEG_LAT,
  };
}

/**
 * Build a 3D rectangular footprint polygon.
 * - z as a number → uniform Z at all 4 vertices (flat-top building)
 * - z as a 4-array → [z_sw, z_se, z_ne, z_nw] — per-corner Z (sloped roof)
 *
 * Returns GeoJSON Polygon with [lon, lat, z] triplets (closed ring).
 */
function rect3D(
  center: { lon: number; lat: number },
  widthM: number,
  depthM: number,
  z: number | [number, number, number, number],
) {
  const dLon = widthM / 2 / M_PER_DEG_LON;
  const dLat = depthM / 2 / M_PER_DEG_LAT;
  const zs: [number, number, number, number] = typeof z === "number" ? [z, z, z, z] : z;
  const ring = [
    [center.lon - dLon, center.lat - dLat, zs[0]], // SW
    [center.lon + dLon, center.lat - dLat, zs[1]], // SE
    [center.lon + dLon, center.lat + dLat, zs[2]], // NE
    [center.lon - dLon, center.lat + dLat, zs[3]], // NW
    [center.lon - dLon, center.lat - dLat, zs[0]], // close ring
  ];
  return { type: "Polygon", coordinates: [ring] };
}

interface Bldg3D {
  name: string;
  off: [number, number]; // [east-m, north-m] from station (further shifted +500m N globally)
  w: number;
  d: number;
  z: number | [number, number, number, number]; // uniform or per-corner Z
  use: "commercial" | "residential" | "industrial" | "institutional" | "mixed_use" | "other";
}

// 15 uniform-Z (heights: 3× each of 6, 25, 50, 100, 200)
const UNIFORM: Bldg3D[] = [
  // 200m
  { name: "Tower A (200m flat)",   off: [-260,  100], w: 50, d: 50, z: 200, use: "commercial" },
  { name: "Tower B (200m flat)",   off: [ 100,  150], w: 55, d: 45, z: 200, use: "commercial" },
  { name: "Tower C (200m flat)",   off: [ 250, -100], w: 50, d: 50, z: 200, use: "commercial" },
  // 100m
  { name: "Tower D (100m flat)",   off: [-160, -100], w: 45, d: 45, z: 100, use: "commercial" },
  { name: "Tower E (100m flat)",   off: [  10,  280], w: 50, d: 40, z: 100, use: "commercial" },
  { name: "Tower F (100m flat)",   off: [ 200,  220], w: 45, d: 45, z: 100, use: "commercial" },
  // 50m
  { name: "Block G (50m flat)",    off: [-340, -220], w: 35, d: 35, z:  50, use: "mixed_use" },
  { name: "Block H (50m flat)",    off: [ -30, -250], w: 35, d: 30, z:  50, use: "residential" },
  { name: "Block I (50m flat)",    off: [ 320,  120], w: 30, d: 35, z:  50, use: "residential" },
  // 25m
  { name: "House J (25m flat)",    off: [-360,   80], w: 22, d: 20, z:  25, use: "residential" },
  { name: "House K (25m flat)",    off: [ 130,  -10], w: 22, d: 22, z:  25, use: "residential" },
  { name: "House L (25m flat)",    off: [ 360, -200], w: 22, d: 20, z:  25, use: "residential" },
  // 6m (tiny pavilions)
  { name: "Hut M (6m flat)",       off: [-180,    0], w: 12, d: 12, z:   6, use: "other" },
  { name: "Hut N (6m flat)",       off: [  60,  -40], w: 10, d: 10, z:   6, use: "other" },
  { name: "Hut O (6m flat)",       off: [ 280,   30], w: 10, d: 10, z:   6, use: "other" },
];

// 5 varied-Z (sloped). Corners are [SW, SE, NE, NW].
// E.g., east side high / west side low → visualizes as wedge in a real 3D renderer
//       but MapLibre will flatten to max Z = the east-side value.
const SLOPED: Bldg3D[] = [
  // east tall / west short  — wedge slope west→east up
  { name: "Slope P (W30 / E80)",   off: [-100, -350], w: 40, d: 30, z: [30, 80, 80, 30], use: "commercial" },
  // north tall / south short — wedge S→N up
  { name: "Slope Q (S40 / N120)",  off: [ 180,  350], w: 30, d: 40, z: [40, 40, 120, 120], use: "commercial" },
  // SW corner spike — one corner much higher
  { name: "Spike R (SW=150)",      off: [-280,  300], w: 35, d: 35, z: [150, 20, 20, 20], use: "other" },
  // gentle slope, smaller delta
  { name: "Slope S (50 → 70)",     off: [ -60,  100], w: 35, d: 35, z: [50, 70, 70, 50], use: "mixed_use" },
  // four different corner heights (stepped)
  { name: "Stepped T (15/45/90/60)", off: [ 320, -300], w: 35, d: 30, z: [15, 45, 90, 60], use: "industrial" },
];

const BUILDINGS: Bldg3D[] = [...UNIFORM, ...SLOPED];

console.log(`Plan: ${BUILDINGS.length} buildings (${UNIFORM.length} flat-top + ${SLOPED.length} sloped) using vertex-Z geometry\n`);

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("Step 0: Checking CMS + auth…");
  await ensureAuth();

  console.log("\nStep 1: Checking for existing 'building_3d' model…");
  const existingModels = await api<Array<{ id: string; key: string }>>("/definitions/models");
  if (existingModels.some((m) => m.key === "building_3d")) {
    throw new Error("Model 'building_3d' already exists. Delete it via CMS UI or REST and re-run.");
  }

  console.log("\nStep 2: Creating 'building_3d' model…");
  const model = await api<{ id: string; key: string }>("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "building_3d",
      name: "Building (3D geom)",
      description: "Building with true 3D footprint geometry (vertex Z) — no height attribute",
      displayField: "name",
    }),
  });
  console.log(`  → model.id = ${model.id}`);

  console.log("\nStep 3: Adding fields (3D footprint + name + use_type, NO height_m)…");
  await api(`/definitions/models/${model.id}/fields`, {
    method: "POST",
    body: JSON.stringify([
      {
        key: "footprint",
        label: "Footprint (3D)",
        fieldType: "geometry",
        geometryType: "POLYGON",
        geometrySrid: 4326,
        geometryIs3D: true,
        isRequired: true,
        orderIndex: 0,
      },
      { key: "name", label: "Building Name", fieldType: "string", orderIndex: 1 },
      {
        key: "use_type",
        label: "Use Type",
        fieldType: "enum_",
        enumValues: ["residential", "commercial", "industrial", "institutional", "mixed_use", "other"],
        orderIndex: 2,
      },
    ]),
  });

  console.log("\nStep 4: Setting primaryGeometryField=footprint…");
  await api(`/definitions/models/${model.id}`, {
    method: "PUT",
    body: JSON.stringify({ primaryGeometryField: "footprint" }),
  });

  console.log("\nStep 5: Auto-approval governance…");
  await api("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: model.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });

  console.log(`\nStep 6: Ingesting ${BUILDINGS.length} buildings…`);
  const entities = BUILDINGS.map((b) => ({
    type: "building_3d",
    properties: {
      footprint: rect3D(offsetCenter(b.off[0], b.off[1]), b.w, b.d, b.z),
      name: b.name,
      use_type: b.use,
    },
  }));
  const ingestResult = await api<{ approved: number; pending: number; skipped: number; total: number }>(
    "/ingestion/governed",
    { method: "POST", body: JSON.stringify({ entities, source: "machine" }) },
  );
  console.log(
    `  → approved=${ingestResult.approved} pending=${ingestResult.pending} skipped=${ingestResult.skipped} total=${ingestResult.total}`,
  );

  console.log("\nStep 7: Creating dataset 'Tokyo Station Buildings (3D geom)'…");
  const dataset = await api<{ id: string }>("/datasets", {
    method: "POST",
    body: JSON.stringify({ name: "Tokyo Station Buildings (3D geom)", entityTypes: [] }),
  });
  console.log(`  → dataset.id = ${dataset.id}`);

  console.log("\nStep 8: Binding model…");
  await api(`/definitions/datasets/${dataset.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({ modelDefinitionId: model.id }),
  });

  console.log("\nStep 9: Snapshot…");
  const snapshot = await api<{ id: string; version: number }>(`/datasets/${dataset.id}/snapshot`, { method: "POST" });
  console.log(`  → snapshot.id = ${snapshot.id} (version ${snapshot.version})`);

  console.log("\nStep 10: Publish…");
  await api("/publications/publish", {
    method: "POST",
    body: JSON.stringify({ datasetSnapshotId: snapshot.id }),
  });

  console.log("\n✓ Done.");
  console.log("\nVerify Delivery API returns 3D coords:");
  console.log(`  curl -sH "X-API-Key: $SEED_API_KEY" \\`);
  console.log(`    "http://localhost:3001/api/v1/delivery/datasets/${dataset.id}/entities?format=geojson&pageSize=2" | python3 -m json.tool`);
  console.log("  Expect: coordinates entries are [lon, lat, z] triplets");
  console.log("\nVerify Viewer:");
  console.log("  Open http://localhost:8090 → select 'Tokyo Station Buildings (3D geom)' → click 3D");
  console.log("  Flat-top buildings extrude correctly. Sloped buildings flatten to max-Z box (MapLibre limit).");
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err.message);
  console.error("Clean partial state by deleting the 'building_3d' model and the 'Tokyo Station Buildings (3D geom)' dataset.");
  process.exit(1);
});
