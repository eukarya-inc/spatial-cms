import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const API_BASE = `http://localhost:${process.env.PORT || 3001}/api/v1`;
const SEED_WORKSPACE = process.env.SEED_WORKSPACE || "default";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Workspace-Key": SEED_WORKSPACE,
      ...((opts.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  // ── Step 1: Clean database ──
  console.log("Step 1: Cleaning database...");
  await prisma.activeReleaseState.deleteMany();
  await prisma.publication.deleteMany();
  await prisma.datasetSnapshot.deleteMany();
  await prisma.datasetModelBinding.deleteMany();
  await prisma.datasetDefinition.deleteMany();
  await prisma.governancePolicy.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.entityVersion.deleteMany();
  // Delete entities with raw SQL to bypass Unsupported geometry field issues
  await prisma.$executeRaw`DELETE FROM entity`;
  await prisma.relationDefinition.deleteMany();
  await prisma.fieldDefinition.deleteMany();
  await prisma.modelDefinition.deleteMany();
  console.log("  All data cleared.");

  // ── Step 2: Create Building model ──
  console.log("\nStep 2: Creating Building model...");
  const model = await apiFetch("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "building",
      name: "Building",
      geometryType: "POLYGON",
    }),
  });
  console.log(`  Model: ${model.id}`);

  // Add fields
  const fields = [
    { key: "name", label: "Name", fieldType: "string", isRequired: false, orderIndex: 0 },
    { key: "name_ja", label: "Name (Japanese)", fieldType: "string", isRequired: false, orderIndex: 1 },
    {
      key: "building_type",
      label: "Building Type",
      fieldType: "enum_",
      isRequired: false,
      enumValues: ["yes", "apartments", "commercial", "retail", "house", "industrial", "residential", "public", "school", "hospital", "office", "church", "temple", "shrine", "hotel", "warehouse", "garage", "roof", "train_station", "other"],
      orderIndex: 2,
    },
    { key: "height", label: "Height (m)", fieldType: "number", isRequired: false, validationJson: { min: 0 }, orderIndex: 3 },
    { key: "levels", label: "Floors", fieldType: "number", isRequired: false, validationJson: { min: 0 }, orderIndex: 4 },
    { key: "addr_full", label: "Address", fieldType: "string", isRequired: false, orderIndex: 5 },
    { key: "addr_housenumber", label: "House Number", fieldType: "string", isRequired: false, orderIndex: 6 },
    { key: "addr_postcode", label: "Postal Code", fieldType: "string", isRequired: false, orderIndex: 7 },
  ];

  for (const f of fields) {
    await apiFetch(`/definitions/models/${model.id}/fields`, {
      method: "POST",
      body: JSON.stringify(f),
    });
  }
  console.log(`  ${fields.length} fields created.`);

  // ── Step 3: Set governance policy (auto-approval) ──
  console.log("\nStep 3: Setting governance policy...");
  await apiFetch("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: model.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });
  console.log("  Auto-approval enabled for Building model.");

  // ── Step 4: Load OSM data ──
  console.log("\nStep 4: Loading buildings from OpenStreetMap data...");
  const cacheFile = new URL("./taito-buildings.json", import.meta.url).pathname;
  let elements: any[];

  if (existsSync(cacheFile)) {
    console.log("  Using cached file: taito-buildings.json");
    const osmData = JSON.parse(readFileSync(cacheFile, "utf-8"));
    elements = osmData.elements || [];
  } else {
    console.log("  Fetching from Overpass API...");
    const overpassQuery = `[out:json][timeout:60];area["name"="台東区"]["admin_level"="7"]->.a;way["building"](area.a);out body geom 1000;`;
    const osmRes = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: `data=${encodeURIComponent(overpassQuery)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const osmData = await osmRes.json();
    elements = osmData.elements || [];
  }
  console.log(`  Got ${elements.length} buildings.`);

  // ── Step 5: Transform OSM → CMS entities ──
  console.log("\nStep 5: Transforming data...");
  const entities = elements.map((el: any) => {
    const tags = el.tags || {};
    const geometry = el.geometry as Array<{ lat: number; lon: number }>;

    // Build properties
    const properties: Record<string, unknown> = {};
    if (tags.name) properties.name = tags.name;
    if (tags["name:ja"]) properties.name_ja = tags["name:ja"];

    // Normalize building type
    const bt = tags.building || "yes";
    const knownTypes = ["yes", "apartments", "commercial", "retail", "house", "industrial", "residential", "public", "school", "hospital", "office", "church", "temple", "shrine", "hotel", "warehouse", "garage", "roof", "train_station"];
    properties.building_type = knownTypes.includes(bt) ? bt : "other";

    if (tags.height) properties.height = parseFloat(tags.height) || undefined;
    if (tags["building:levels"]) properties.levels = parseInt(tags["building:levels"]) || undefined;

    // Address
    const addrParts = [tags["addr:province"], tags["addr:city"], tags["addr:quarter"], tags["addr:neighbourhood"]].filter(Boolean);
    if (addrParts.length) properties.addr_full = addrParts.join("");
    if (tags["addr:housenumber"]) properties.addr_housenumber = tags["addr:housenumber"];
    if (tags["addr:postcode"]) properties.addr_postcode = tags["addr:postcode"];

    // If no name, generate one from address or type
    if (!properties.name) {
      if (properties.addr_full && properties.addr_housenumber) {
        properties.name = `${properties.addr_full} ${properties.addr_housenumber}`;
      } else {
        properties.name = `${bt} (OSM ${el.id})`;
      }
    }

    // Convert OSM nodes to GeoJSON Polygon
    // OSM way geometry is an array of {lat, lon} — close the ring if needed
    const coords = geometry.map((n: { lat: number; lon: number }) => [n.lon, n.lat]);
    if (coords.length > 0) {
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push([...first]); // Close the ring
      }
    }

    return {
      type: "building",
      properties,
      geometry: coords.length >= 4
        ? { type: "Polygon", coordinates: [coords] }
        : undefined,
    };
  });

  const withGeometry = entities.filter((e: any) => e.geometry);
  console.log(`  ${withGeometry.length} with valid polygon geometry.`);

  // ── Step 6: Import via API ──
  console.log("\nStep 6: Importing to CMS...");
  // Import in batches of 100
  const batchSize = 100;
  let totalImported = 0;
  let totalSkipped = 0;

  for (let i = 0; i < withGeometry.length; i += batchSize) {
    const batch = withGeometry.slice(i, i + batchSize);
    const result = await apiFetch("/ingestion/import", {
      method: "POST",
      body: JSON.stringify({
        entities: batch,
        source: "import_",
        options: { skipInvalid: true },
      }),
    });
    totalImported += result.imported;
    totalSkipped += result.skipped;
    process.stdout.write(`  Batch ${Math.floor(i / batchSize) + 1}: ${result.imported} imported, ${result.skipped} skipped\n`);
  }
  console.log(`  Total: ${totalImported} imported, ${totalSkipped} skipped.`);

  // ── Step 7: Create Dataset + Bind + Snapshot + Publish ──
  console.log("\nStep 7: Creating dataset and publishing...");

  const dataset = await apiFetch("/datasets", {
    method: "POST",
    body: JSON.stringify({ name: "Taito-ku Buildings" }),
  });
  console.log(`  Dataset: ${dataset.id}`);

  await apiFetch(`/definitions/datasets/${dataset.id}/bindings`, {
    method: "POST",
    body: JSON.stringify({ modelDefinitionId: model.id }),
  });
  console.log("  Model bound to dataset.");

  const snapshot = await apiFetch(`/datasets/${dataset.id}/snapshot`, {
    method: "POST",
  });
  console.log(`  Snapshot v${snapshot.version}: ${Array.isArray(snapshot.manifest) ? snapshot.manifest.length : "?"} entities.`);

  const publication = await apiFetch("/publications/publish", {
    method: "POST",
    body: JSON.stringify({ datasetSnapshotId: snapshot.id }),
  });
  console.log(`  Published! (publication: ${publication.id})`);

  // ── Done ──
  console.log("\n=== Setup Complete ===");
  console.log(`Model:   building (${model.id})`);
  console.log(`Dataset: Taito-ku Buildings (${dataset.id})`);
  console.log(`Records: ${totalImported}`);
  console.log(`\nTest URLs:`);
  console.log(`  Dashboard:   http://localhost:3001/#dashboard`);
  console.log(`  Buildings:   http://localhost:3001/#manage/records/building`);
  console.log(`  Delivery:    http://localhost:3001/api/v1/delivery/datasets/${dataset.id}/entities?pageSize=10`);
  console.log(`  GeoJSON:     http://localhost:3001/api/v1/delivery/datasets/${dataset.id}/entities?format=geojson&pageSize=10`);
  console.log(`  OGC:         http://localhost:3001/api/v1/ogc/collections/${dataset.id}/items?limit=10`);
  console.log(`  Bbox query:  http://localhost:3001/api/v1/delivery/datasets/${dataset.id}/entities?bbox=139.76,35.70,139.80,35.73`);
  console.log(`  Schema:      http://localhost:3001/api/v1/delivery/datasets/${dataset.id}/schema`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
