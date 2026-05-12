/**
 * Seed ~25 buildings around Tokyo Station for testing 3D fill-extrusion rendering
 * in examples/viewer. Creates the model + fields + governance + dataset + snapshot + publish.
 *
 * Run: npx tsx scripts/seed-3d-buildings.ts
 *
 * Auth: tries existing API keys. Set SEED_API_KEY=scms_xxx to use a specific key,
 * or leave unset and the script will bootstrap an admin key if none exist.
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
  // Check whether auth is required
  const status = (await api<{ required: boolean }>("/api-keys/status")).required;
  if (!status) {
    console.log("  Auth disabled (DELIVERY_API_KEY_REQUIRED=false). Proceeding without API key.");
    return;
  }
  // Use provided key
  if (process.env.SEED_API_KEY) {
    API_KEY = process.env.SEED_API_KEY;
    console.log("  Using SEED_API_KEY from env.");
    return;
  }
  // Try bootstrap (only works if no keys exist yet)
  const boot = await fetch(`${API_BASE}/api-keys/bootstrap`, { method: "POST" });
  if (boot.ok) {
    const json = (await boot.json()) as { key: string };
    API_KEY = json.key;
    console.log(`  Bootstrapped admin API key: ${API_KEY!.slice(0, 12)}…`);
    console.log(`  (full key not printed — keep it or generate new ones via /api/v1/api-keys)`);
    return;
  }
  throw new Error(
    "Auth required but no API key available. Either:\n" +
      "  1) Set DELIVERY_API_KEY_REQUIRED=false in .env (dev only), or\n" +
      "  2) Pass SEED_API_KEY=scms_xxx (existing admin-scope key), or\n" +
      "  3) Delete all existing keys so bootstrap can run.",
  );
}

// ─── Building data ─────────────────────────────────────────────────

const STATION = { lon: 139.7671, lat: 35.6812 };

// metersToDeg approximations at Tokyo's latitude (~35.68°N)
const M_PER_DEG_LAT = 111_000;
const M_PER_DEG_LON = 90_650;

function rectPolygon(center: { lon: number; lat: number }, widthM: number, depthM: number) {
  const dLon = widthM / 2 / M_PER_DEG_LON;
  const dLat = depthM / 2 / M_PER_DEG_LAT;
  const ring = [
    [center.lon - dLon, center.lat - dLat],
    [center.lon + dLon, center.lat - dLat],
    [center.lon + dLon, center.lat + dLat],
    [center.lon - dLon, center.lat + dLat],
    [center.lon - dLon, center.lat - dLat], // close ring
  ];
  return { type: "Polygon", coordinates: [ring] };
}

function offsetCenter(dLonM: number, dLatM: number) {
  return {
    lon: STATION.lon + dLonM / M_PER_DEG_LON,
    lat: STATION.lat + dLatM / M_PER_DEG_LAT,
  };
}

interface Bldg {
  name: string;
  off: [number, number]; // [east-meters, north-meters] from Tokyo Station
  w: number; // width (E-W) in m
  d: number; // depth (N-S) in m
  h: number; // height in m
  use: "commercial" | "residential" | "institutional" | "mixed_use" | "industrial" | "other";
  year?: number;
}

const BUILDINGS: Bldg[] = [
  // ── Landmarks (height 150-250m) ─────────────────────────
  { name: "Marunouchi Building",        off: [-320,  -10], w: 75,  d: 55,  h: 180, use: "mixed_use",   year: 2002 },
  { name: "Shin-Marunouchi Building",   off: [-330, 100],  w: 70,  d: 55,  h: 198, use: "mixed_use",   year: 2007 },
  { name: "Marunouchi Park Building",   off: [-320, -150], w: 80,  d: 70,  h: 156, use: "commercial",  year: 2009 },
  { name: "Pacific Century Place",      off: [ 150, -380], w: 60,  d: 60,  h: 150, use: "commercial",  year: 2001 },
  { name: "Otemachi Tower",             off: [-180,  280], w: 80,  d: 70,  h: 200, use: "commercial",  year: 2014 },
  { name: "JP Tower (KITTE)",           off: [ -90, -150], w: 95,  d: 80,  h: 200, use: "mixed_use",   year: 2012 },

  // ── Mid-rise (60-100m) ──────────────────────────────────
  { name: "Mitsubishi Building",        off: [-260, -120], w: 60,  d: 50,  h: 100, use: "commercial",  year: 1973 },
  { name: "Tokyo Sankei Building",      off: [-100, 280],  w: 55,  d: 50,  h: 100, use: "commercial",  year: 2005 },
  { name: "Yaesu Book Center Bldg",     off: [ 220,  -40], w: 40,  d: 35,  h: 70,  use: "commercial",  year: 1978 },
  { name: "Tekko Building",             off: [ 100,  170], w: 60,  d: 50,  h: 90,  use: "commercial",  year: 1959 },
  { name: "Sapia Tower",                off: [  60,  220], w: 50,  d: 45,  h: 90,  use: "commercial",  year: 2007 },
  { name: "Daimaru Tokyo",              off: [ 180,   30], w: 70,  d: 50,  h: 80,  use: "commercial",  year: 2007 },

  // ── Tokyo Station itself (long, low) ────────────────────
  { name: "Tokyo Station Marunouchi",   off: [ -20,    0], w: 30,  d: 350, h: 45,  use: "institutional", year: 1914 },

  // ── Regular office (30-50m) ─────────────────────────────
  { name: "Marunouchi Building 7",      off: [-250,  220], w: 35,  d: 30,  h: 40,  use: "commercial" },
  { name: "Yaesu Office 1",             off: [ 250,  120], w: 30,  d: 30,  h: 50,  use: "commercial" },
  { name: "Yaesu Office 2",             off: [ 280, -120], w: 35,  d: 35,  h: 35,  use: "commercial" },
  { name: "Otemachi Annex A",           off: [  20,  380], w: 40,  d: 30,  h: 45,  use: "commercial" },
  { name: "Otemachi Annex B",           off: [-150,  400], w: 35,  d: 30,  h: 50,  use: "commercial" },

  // ── Lower buildings (10-25m) ────────────────────────────
  { name: "Marunouchi Shop Row",        off: [-200,   60], w: 25,  d: 18,  h: 18,  use: "commercial" },
  { name: "Yaesu Shop Row",             off: [ 220,  -90], w: 22,  d: 18,  h: 15,  use: "commercial" },
  { name: "Underground Plaza Vent",     off: [ 100,  -30], w: 12,  d: 12,  h: 8,   use: "other" },
  { name: "Marunouchi Cafe Block",      off: [-180,  180], w: 20,  d: 15,  h: 12,  use: "mixed_use" },
  { name: "Otemachi Small Office",      off: [ -50,  330], w: 25,  d: 20,  h: 25,  use: "commercial" },
  { name: "Yaesu Mini Tower",           off: [ 320,   60], w: 18,  d: 18,  h: 30,  use: "commercial" },

  // ── Tiny baseline (under 10m) ───────────────────────────
  { name: "Service Building",           off: [   5,  -80], w: 10,  d: 10,  h: 6,   use: "other" },
];

console.log(`Plan: ${BUILDINGS.length} buildings around Tokyo Station\n`);

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("Step 0: Checking CMS reachability + auth…");
  await ensureAuth();

  console.log("\nStep 1: Checking for existing 'building' model…");
  const existingModels = await api<Array<{ id: string; key: string }>>("/definitions/models");
  if (existingModels.some((m) => m.key === "building")) {
    throw new Error(
      "Model with key 'building' already exists. Delete it first (via CMS UI or POST /api/v1/definitions/models DELETE) and re-run.",
    );
  }

  console.log("\nStep 2: Creating 'building' model…");
  const model = await api<{ id: string; key: string }>("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "building",
      name: "Building",
      description: "Building footprint with height — for 3D rendering test",
      displayField: "name",
    }),
  });
  console.log(`  → model.id = ${model.id}`);

  console.log("\nStep 3: Adding fields (footprint geometry + attributes)…");
  await api(`/definitions/models/${model.id}/fields`, {
    method: "POST",
    body: JSON.stringify([
      {
        key: "footprint",
        label: "Footprint",
        fieldType: "geometry",
        geometryType: "POLYGON",
        geometrySrid: 4326,
        geometryIs3D: false,
        isRequired: true,
        orderIndex: 0,
      },
      { key: "name",      label: "Building Name", fieldType: "string", orderIndex: 1 },
      { key: "height_m",  label: "Height (m)",    fieldType: "number", validationJson: { min: 0 }, orderIndex: 2 },
      {
        key: "use_type",
        label: "Use Type",
        fieldType: "enum_",
        enumValues: ["residential", "commercial", "industrial", "institutional", "mixed_use", "other"],
        orderIndex: 3,
      },
      { key: "year_built", label: "Year Built", fieldType: "number", orderIndex: 4 },
    ]),
  });

  console.log("\nStep 4: Setting model.primaryGeometryField = 'footprint'…");
  await api(`/definitions/models/${model.id}`, {
    method: "PUT",
    body: JSON.stringify({ primaryGeometryField: "footprint" }),
  });

  console.log("\nStep 5: Setting auto-approval governance…");
  await api("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: model.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });

  console.log(`\nStep 6: Ingesting ${BUILDINGS.length} buildings via /ingestion/governed…`);
  const entities = BUILDINGS.map((b) => {
    const center = offsetCenter(b.off[0], b.off[1]);
    const properties: Record<string, unknown> = {
      footprint: rectPolygon(center, b.w, b.d),
      name: b.name,
      height_m: b.h,
      use_type: b.use,
    };
    if (b.year !== undefined) properties.year_built = b.year;
    return { type: "building", properties };
  });
  const ingestResult = await api<{ created: number; entities?: unknown[] }>(
    "/ingestion/governed",
    {
      method: "POST",
      body: JSON.stringify({ entities, source: "machine" }),
    },
  );
  console.log(`  → ingestion result: ${JSON.stringify(ingestResult).slice(0, 200)}`);

  console.log("\nStep 7: Creating dataset 'Tokyo Station Buildings'…");
  const dataset = await api<{ id: string; name: string }>("/datasets", {
    method: "POST",
    body: JSON.stringify({
      name: "Tokyo Station Buildings",
      entityTypes: [],
    }),
  });
  console.log(`  → dataset.id = ${dataset.id}`);

  console.log("\nStep 8: Binding building model to dataset…");
  await api(`/definitions/datasets/${dataset.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({ modelDefinitionId: model.id }),
  });

  console.log("\nStep 9: Generating snapshot…");
  const snapshot = await api<{ id: string; version: number }>(
    `/datasets/${dataset.id}/snapshot`,
    { method: "POST" },
  );
  console.log(`  → snapshot.id = ${snapshot.id} (version ${snapshot.version})`);

  console.log("\nStep 10: Publishing snapshot to Delivery…");
  await api("/publications/publish", {
    method: "POST",
    body: JSON.stringify({ datasetSnapshotId: snapshot.id }),
  });

  console.log("\n✓ Done.");
  console.log("\nNext:");
  console.log("  1. Start the viewer if not running: ./dev.sh start viewer");
  console.log("  2. Open http://localhost:8090");
  console.log("  3. Select dataset \"Tokyo Station Buildings\"");
  console.log("  4. Click the 3D toggle → buildings should extrude by height_m");
  console.log(`\nDataset ID: ${dataset.id}`);
  console.log(`Model ID:   ${model.id}`);
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err.message);
  console.error(
    "\nTo clean up partial state: delete the 'building' model and any 'Tokyo Station Buildings' dataset via CMS UI or REST,",
  );
  console.error("then re-run.");
  process.exit(1);
});
