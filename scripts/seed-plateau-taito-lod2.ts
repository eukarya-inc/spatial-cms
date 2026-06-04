/**
 * Seed a real PLATEAU 台東区 LOD2 CityGML mesh into the `plateau-taito-lod2`
 * workspace. Mirrors the synthetic seed `seed-lod2-buildings.ts` but reads
 * its input from a real PLATEAU 2.0 CityGML file rather than a hand-coded
 * BUILDINGS[] array.
 *
 * Two-model decomposition (same idea as the synthetic LOD2 seed):
 *
 *   building_lod2     — semantic anchor: gml_id, codeSpace codes (class,
 *                       usage), measured_height, storeys above/below,
 *                       creation_date, 2D footprint
 *   boundary_surface  — geometric carriers (wall / roof / ground), each
 *                       with its own 3D polygon + material color,
 *                       referencing the parent building by both gml_id
 *                       (CityGML-style) and UUID (CMS-native FK)
 *
 * Input: a single PLATEAU mesh `.gml` file (typically 40-160MB). Default:
 *   ~/data/plateau_taitoku/udx/bldg/53394651_bldg_6697_op.gml   (smallest mesh)
 * Override via PLATEAU_BLDG_FILE env var.
 *
 * Filtering: only buildings with a non-empty `<bldg:boundedBy>` list (real
 * LOD2 — has wall/roof/ground surfaces) are imported. LOD1-only buildings
 * are skipped.
 *
 * Run:
 *   SEED_API_KEY=scms_xxx npx tsx scripts/seed-plateau-taito-lod2.ts
 *   SEED_API_KEY=scms_xxx npx tsx scripts/seed-plateau-taito-lod2.ts --limit 50
 *   SEED_API_KEY=scms_xxx npx tsx scripts/seed-plateau-taito-lod2.ts --reset
 *
 * Auth: SEED_API_KEY=scms_xxx (admin) or bootstrap when zero keys exist.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const API_BASE = `http://localhost:${process.env.PORT || 3001}/api/v1`;
const WORKSPACE = process.env.SEED_WORKSPACE || "plateau-taito-lod2";

const DEFAULT_BLDG_FILE = path.join(
  os.homedir(),
  "data/plateau_taitoku/udx/bldg/53394651_bldg_6697_op.gml",
);
const BLDG_FILE = expandUserPath(process.env.PLATEAU_BLDG_FILE || DEFAULT_BLDG_FILE);

function expandUserPath(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function parseLimit(): number {
  const idx = process.argv.indexOf("--limit");
  if (idx >= 0 && process.argv[idx + 1]) return Math.max(1, parseInt(process.argv[idx + 1], 10) || 30);
  return 30;
}
const LIMIT = parseLimit();

let API_KEY: string | null = null;

async function api<T = unknown>(p: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Workspace-Key": WORKSPACE,
  };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const res = await fetch(`${API_BASE}${p}`, { ...opts, headers: { ...headers, ...(opts.headers as any) } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.method || "GET"} ${p} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function ensureAuth() {
  const status = (await api<{ required: boolean }>("/api-keys/status")).required;
  if (!status) { console.log("  Auth disabled. Proceeding without API key."); return; }
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
  throw new Error("Auth required but no key. Set SEED_API_KEY=scms_xxx (admin scope).");
}

// ─── XML helpers ──────────────────────────────────────────────────────

/**
 * Parse a CityGML `<gml:posList>` text into an array of [lon, lat, z] tuples.
 * PLATEAU uses srsName=EPSG:6697 with axis order (lat, lon, height); we swap
 * to GeoJSON [lon, lat, h] here so callers can treat the result as 4326-ish
 * geometry directly. JGD2011 ↔ WGS84 in Tokyo differs by ~30cm — ignored
 * for the demo.
 */
function parsePosList(text: string): number[][] {
  const nums = text.trim().split(/\s+/).map(Number);
  if (nums.length % 3 !== 0) throw new Error(`posList not a multiple of 3: got ${nums.length} numbers`);
  const out: number[][] = [];
  for (let i = 0; i < nums.length; i += 3) {
    // PLATEAU order: lat lon h → swap to lon lat h
    out.push([nums[i + 1], nums[i], nums[i + 2]]);
  }
  return out;
}

/** Drop Z to make a 2D ring. */
function flatten2D(coords3: number[][]): number[][] {
  return coords3.map((c) => [c[0], c[1]]);
}

/** Walk a path like `a.b.c` on a parsed object, returning undefined if any step is missing. */
function dig(obj: any, ...keys: string[]): any {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Pull a posList string from any node containing `.Polygon.exterior.LinearRing.posList`. */
function extractPosList(node: any): string | undefined {
  const txt = dig(node, "Polygon", "exterior", "LinearRing", "posList");
  if (typeof txt === "string") return txt;
  if (txt != null) return String(txt);
  return undefined;
}

// ─── Building extraction ──────────────────────────────────────────────

interface BuildingRecord {
  gmlId: string;
  classCode?: string;
  usageCode?: string;
  measuredHeight?: number;
  storeysAbove?: number;
  storeysBelow?: number;
  creationDate?: string;
  footprint2D: { type: "Polygon"; coordinates: number[][][] };
  surfaces: SurfaceRecord[];
}

interface SurfaceRecord {
  gmlId: string;
  surfaceType: "wall" | "roof" | "ground";
  geometry3D: { type: "Polygon"; coordinates: number[][][] };
}

const SURFACE_TYPE_FIELD: Record<string, "wall" | "roof" | "ground"> = {
  WallSurface: "wall",
  RoofSurface: "roof",
  GroundSurface: "ground",
};

const SURFACE_COLOR: Record<string, string> = {
  wall: "#9ca3af",
  roof: "#b91c1c",
  ground: "#6b7280",
};

/**
 * Pull semantic surfaces out of a Building's <bldg:boundedBy> list. Each
 * boundedBy node wraps exactly one of {WallSurface, RoofSurface, GroundSurface}
 * (a CityGML choice element). We grab the first surfaceMember polygon — demo
 * doesn't try to handle multi-polygon or holes.
 */
function extractSurfaces(boundedByList: any[]): SurfaceRecord[] {
  const out: SurfaceRecord[] = [];
  for (const wrapper of boundedByList) {
    for (const [tag, surfaceType] of Object.entries(SURFACE_TYPE_FIELD)) {
      const surf = wrapper[tag];
      if (!surf) continue;
      const surfaceMembers = dig(surf, "lod2MultiSurface", "MultiSurface", "surfaceMember");
      if (!surfaceMembers) continue;
      const first = Array.isArray(surfaceMembers) ? surfaceMembers[0] : surfaceMembers;
      const posListText = extractPosList(first);
      if (!posListText) continue;
      const coords3 = parsePosList(posListText);
      if (coords3.length < 4) continue;  // need at least a triangle + close
      out.push({
        gmlId: surf["@_id"] ?? `unnamed_${surfaceType}_${out.length}`,
        surfaceType,
        geometry3D: { type: "Polygon", coordinates: [coords3] },
      });
      break;  // wrapper had its surface
    }
  }
  return out;
}

function extractBuilding(bldgNode: any): BuildingRecord | { skip: string } {
  const gmlId = bldgNode["@_id"];
  if (!gmlId) return { skip: "missing gml:id" };

  const boundedByRaw = bldgNode.boundedBy;
  const boundedByList = Array.isArray(boundedByRaw) ? boundedByRaw : boundedByRaw ? [boundedByRaw] : [];
  if (boundedByList.length === 0) return { skip: "no LOD2 boundedBy (LOD1-only)" };

  // 2D footprint from lod0RoofEdge
  const footprintPosList = dig(
    bldgNode,
    "lod0RoofEdge",
    "MultiSurface",
    "surfaceMember",
    "Polygon",
    "exterior",
    "LinearRing",
    "posList",
  ) ?? dig(  // sometimes surfaceMember is wrapped in array
    bldgNode,
    "lod0RoofEdge",
    "MultiSurface",
    "surfaceMember",
    "0",
    "Polygon",
    "exterior",
    "LinearRing",
    "posList",
  );
  if (!footprintPosList) return { skip: "no lod0RoofEdge footprint" };
  const footprintCoords3 = parsePosList(String(footprintPosList));
  if (footprintCoords3.length < 4) return { skip: "lod0RoofEdge footprint too short" };
  const footprint2D = { type: "Polygon" as const, coordinates: [flatten2D(footprintCoords3)] };

  const surfaces = extractSurfaces(boundedByList);
  if (surfaces.length === 0) return { skip: "boundedBy present but yielded no surfaces" };

  // Attributes — codeSpace values come out as numbers via parseTagValue,
  // we always want them as strings (they're identifiers, not magnitudes).
  const classRaw = bldgNode.class;
  const usageRaw = bldgNode.usage;
  const measuredHeightRaw = bldgNode.measuredHeight;
  const storeysAboveRaw = bldgNode.storeysAboveGround;
  const storeysBelowRaw = bldgNode.storeysBelowGround;
  const creationDateRaw = bldgNode.creationDate;

  return {
    gmlId,
    classCode: classRaw != null ? String(unwrapTagValue(classRaw)) : undefined,
    usageCode: usageRaw != null ? String(unwrapTagValue(usageRaw)) : undefined,
    measuredHeight: measuredHeightRaw != null ? Number(unwrapTagValue(measuredHeightRaw)) : undefined,
    storeysAbove: storeysAboveRaw != null ? Number(unwrapTagValue(storeysAboveRaw)) : undefined,
    storeysBelow: storeysBelowRaw != null ? Number(unwrapTagValue(storeysBelowRaw)) : undefined,
    creationDate: creationDateRaw != null ? String(unwrapTagValue(creationDateRaw)) : undefined,
    footprint2D,
    surfaces,
  };
}

/**
 * fast-xml-parser returns either a primitive for `<x>5</x>` or an object
 * `{ "#text": 5, "@_uom": "m" }` for `<x uom="m">5</x>`. Pick the text.
 */
function unwrapTagValue(v: any): unknown {
  if (v && typeof v === "object" && "#text" in v) return v["#text"];
  return v;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Plan: import up to ${LIMIT} LOD2 buildings from\n  ${BLDG_FILE}\ninto workspace "${WORKSPACE}"\n`);

  if (!fs.existsSync(BLDG_FILE)) {
    throw new Error(
      `CityGML file not found at ${BLDG_FILE}\n` +
        `Did you unzip the PLATEAU dataset? Try:\n` +
        `  cd ~/data/plateau_taitoku && unzip 13106_taito-ku_city_2025_citygml_1_op.zip\n` +
        `Or set PLATEAU_BLDG_FILE=/abs/path/to/your.gml`,
    );
  }

  const resetFlag = process.argv.includes("--reset") || process.env.SEED_RESET === "1";

  console.log("Step 0: Auth…");
  await ensureAuth();

  // ─── Step 1: workspace ─────────────────────────────────────────────
  console.log(`\nStep 1: Ensure workspace "${WORKSPACE}"…`);
  const wsList = await api<Array<{ slug: string; name: string }>>("/workspaces");
  let ws = wsList.find((w) => w.slug === WORKSPACE);
  if (!ws) {
    console.log(`  Workspace "${WORKSPACE}" not found — creating…`);
    ws = await api<{ slug: string; name: string }>("/workspaces", {
      method: "POST",
      body: JSON.stringify({
        slug: WORKSPACE,
        name: "PLATEAU 台東区 LOD2",
        description: "Real PLATEAU 台東区 2025 LOD2 building data (CityGML 2.0).",
      }),
    });
  }
  console.log(`  Using workspace: ${ws.slug} (${ws.name})`);

  // ─── Step 1.5: Bootstrap a workspace-bound API key ─────────────────
  // API keys are strictly workspace-bound (PR #26). The caller's key is
  // (usually) bound to "default", which can create workspaces via
  // /workspaces (no resolveWorkspace), but can't create entities in another
  // workspace. We mint a fresh admin key bound to the new workspace
  // directly via Prisma — same mechanism the public bootstrap endpoint
  // uses internally — then swap our API_KEY pointer to it.
  if (API_KEY) {
    const wsRow = await prisma.workspace.findUnique({ where: { slug: WORKSPACE } });
    if (!wsRow) throw new Error(`Workspace ${WORKSPACE} just created but not found in DB`);
    const callerKeyHash = crypto.createHash("sha256").update(API_KEY).digest("hex");
    const callerKey = await prisma.apiKey.findUnique({ where: { keyHash: callerKeyHash } });
    if (callerKey && callerKey.workspaceId !== wsRow.id) {
      const rawNewKey = "scms_" + crypto.randomBytes(16).toString("hex");
      const newKeyHash = crypto.createHash("sha256").update(rawNewKey).digest("hex");
      await prisma.apiKey.create({
        data: {
          name: `seed-plateau-taito-lod2 (${new Date().toISOString().slice(0, 10)})`,
          keyHash: newKeyHash,
          keyPrefix: rawNewKey.substring(0, 13),
          scope: "admin",
          workspaceId: wsRow.id,
        },
      });
      console.log(`  Caller key is bound to a different workspace; minted a fresh admin key for "${WORKSPACE}" (${rawNewKey.slice(0, 13)}…)`);
      API_KEY = rawNewKey;
    }
  }

  // ─── Step 2: models ────────────────────────────────────────────────
  const existingModels = await api<Array<{ id: string; key: string }>>("/definitions/models");
  const targetKeys = ["building_lod2", "boundary_surface"];
  const collisions = existingModels.filter((m) => targetKeys.includes(m.key));
  if (collisions.length) {
    if (resetFlag) {
      console.log(`\nStep 1.5: --reset → cascade-deleting ${collisions.length} existing model(s): ${collisions.map((m) => m.key).join(", ")}`);
      // boundary_surface references building_lod2, so delete it first
      const ordered = [...collisions].sort((a, b) => (a.key === "building_lod2" ? 1 : -1));
      for (const m of ordered) {
        await api(`/definitions/models/${m.id}`, { method: "DELETE" });
        console.log(`  ✗ deleted ${m.key} (${m.id.slice(0, 8)}…)`);
      }
    } else {
      throw new Error(
        `Models already exist in "${WORKSPACE}": ${collisions.map((m) => m.key).join(", ")}. ` +
          `Re-run with --reset to cascade-delete them, or delete via the CMS UI.`,
      );
    }
  }

  console.log("\nStep 2: Create building_lod2 model…");
  const bldgModel = await api<{ id: string }>("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "building_lod2",
      name: "LOD2 Building (PLATEAU)",
      description: "PLATEAU CityGML LOD2 Building. Codes (class, usage) kept as raw codeSpace ids; 3D wall/roof/ground geometry lives on linked BoundarySurfaces.",
      primaryGeometryField: "footprint",
      displayField: "gml_id",
    }),
  });
  await api(`/definitions/models/${bldgModel.id}/fields`, {
    method: "POST",
    body: JSON.stringify([
      { key: "gml_id",               label: "GML ID",                       fieldType: "string", isRequired: true, orderIndex: 0 },
      { key: "class_code",           label: "Building Class (codeSpace)",   fieldType: "string", orderIndex: 1 },
      { key: "usage_code",           label: "Building Usage (codeSpace)",   fieldType: "string", orderIndex: 2 },
      { key: "measured_height",      label: "Measured Height (m)",          fieldType: "number", validationJson: { min: 0 }, orderIndex: 3 },
      { key: "storeys_above_ground", label: "Storeys Above Ground",         fieldType: "number", validationJson: { min: 0 }, orderIndex: 4 },
      { key: "storeys_below_ground", label: "Storeys Below Ground",         fieldType: "number", validationJson: { min: 0 }, orderIndex: 5 },
      { key: "creation_date",        label: "Creation Date",                fieldType: "date",   orderIndex: 6 },
      {
        key: "footprint",
        label: "Footprint",
        fieldType: "geometry",
        geometryType: "POLYGON",
        geometrySrid: 4326,
        geometryMode: "2D",
        isRequired: true,
        orderIndex: 7,
      },
    ]),
  });
  await api("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: bldgModel.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });
  console.log(`  → ${bldgModel.id}`);

  console.log("\nStep 3: Create boundary_surface model…");
  const surfModel = await api<{ id: string }>("/definitions/models", {
    method: "POST",
    body: JSON.stringify({
      key: "boundary_surface",
      name: "Boundary Surface (LOD2)",
      description: "Wall / roof / ground polygon with material color; references its parent LOD2 Building. 3D mode — vertex Z required.",
      primaryGeometryField: "geometry",
      displayField: "gml_id",
    }),
  });
  await api(`/definitions/models/${surfModel.id}/fields`, {
    method: "POST",
    body: JSON.stringify([
      { key: "gml_id",        label: "GML ID",        fieldType: "string", isRequired: true, orderIndex: 0 },
      { key: "parent_gml_id", label: "Parent GML ID", fieldType: "string", isRequired: true, orderIndex: 1 },
      { key: "building_id",   label: "Building",      fieldType: "reference", referenceModelKey: "building_lod2", isRequired: true, orderIndex: 2 },
      {
        key: "surface_type", label: "Surface Type", fieldType: "enum_",
        enumValues: ["wall", "roof", "ground"], isRequired: true, orderIndex: 3,
      },
      { key: "material_color", label: "Material Color", fieldType: "string", orderIndex: 4 },
      {
        key: "geometry",
        label: "Surface Geometry",
        fieldType: "geometry",
        geometryType: "POLYGON",
        geometrySrid: 4326,
        geometryMode: "3D",
        isRequired: true,
        orderIndex: 5,
      },
    ]),
  });
  await api("/definitions/governance/policies", {
    method: "POST",
    body: JSON.stringify({
      targetType: "model",
      targetId: surfModel.id,
      approvalMode: "auto",
      publishMode: "manual",
    }),
  });
  console.log(`  → ${surfModel.id}`);

  // ─── Step 4: parse CityGML ─────────────────────────────────────────
  console.log(`\nStep 4: Parsing ${BLDG_FILE}…`);
  const startParse = Date.now();
  const xmlText = fs.readFileSync(BLDG_FILE, "utf-8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseAttributeValue: true,
    parseTagValue: true,
    isArray: (name) => ["cityObjectMember", "boundedBy", "surfaceMember"].includes(name),
  });
  const doc = parser.parse(xmlText);
  console.log(`  XML parse: ${((Date.now() - startParse) / 1000).toFixed(1)}s, file size ${(xmlText.length / 1024 / 1024).toFixed(1)}MB`);

  const cityObjectMembers = dig(doc, "CityModel", "cityObjectMember") ?? [];
  const memberArr: any[] = Array.isArray(cityObjectMembers) ? cityObjectMembers : [cityObjectMembers];

  let totalBldgs = 0;
  let skippedReasons: Record<string, number> = {};
  const records: BuildingRecord[] = [];
  for (const member of memberArr) {
    const bldg = member.Building;
    if (!bldg) continue;
    totalBldgs++;
    try {
      const rec = extractBuilding(bldg);
      if ("skip" in rec) {
        skippedReasons[rec.skip] = (skippedReasons[rec.skip] ?? 0) + 1;
      } else {
        records.push(rec);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skippedReasons[`error: ${msg.slice(0, 60)}`] = (skippedReasons[`error: ${msg.slice(0, 60)}`] ?? 0) + 1;
    }
    if (records.length >= LIMIT) break;  // stop scanning once we have enough — saves time on huge files
  }
  console.log(`  Scanned ${totalBldgs} <bldg:Building> nodes, ${records.length} LOD2-capable (with boundedBy).`);
  if (Object.keys(skippedReasons).length) {
    console.log(`  Skipped breakdown:`);
    for (const [reason, n] of Object.entries(skippedReasons)) {
      console.log(`    - ${reason}: ${n}`);
    }
  }
  if (records.length === 0) {
    throw new Error("No LOD2 buildings found in this mesh. Try a different PLATEAU_BLDG_FILE.");
  }

  // ─── Step 5: import entities ───────────────────────────────────────
  const toImport = records.slice(0, LIMIT);
  console.log(`\nStep 5: Importing ${toImport.length} buildings + their surfaces (auto-approved)…`);
  let bldgCount = 0;
  let surfCount = 0;
  let bldgFail = 0;
  let surfFail = 0;

  for (let i = 0; i < toImport.length; i++) {
    const rec = toImport[i];
    const shortId = rec.gmlId.slice(0, 12);

    // a) Create Building
    const buildingProps: Record<string, unknown> = {
      gml_id: rec.gmlId,
      footprint: rec.footprint2D,
    };
    if (rec.classCode !== undefined) buildingProps.class_code = rec.classCode;
    if (rec.usageCode !== undefined) buildingProps.usage_code = rec.usageCode;
    // PLATEAU has occasional negative measured_height (data-quality artifact —
    // some buildings couldn't be measured). Our schema validates min:0, so drop
    // those values rather than failing the whole insert.
    if (rec.measuredHeight !== undefined && !Number.isNaN(rec.measuredHeight) && rec.measuredHeight >= 0) {
      buildingProps.measured_height = rec.measuredHeight;
    }
    if (rec.storeysAbove !== undefined && !Number.isNaN(rec.storeysAbove) && rec.storeysAbove >= 0) {
      buildingProps.storeys_above_ground = rec.storeysAbove;
    }
    if (rec.storeysBelow !== undefined && !Number.isNaN(rec.storeysBelow) && rec.storeysBelow >= 0) {
      buildingProps.storeys_below_ground = rec.storeysBelow;
    }
    if (rec.creationDate !== undefined) buildingProps.creation_date = rec.creationDate;

    try {
      await api("/proposals", {
        method: "POST",
        body: JSON.stringify({
          proposedChange: {
            action: "create",
            data: { type: "building_lod2", properties: buildingProps },
          },
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] Building ${shortId}: ${msg.slice(0, 200)}`);
      bldgFail++;
      continue;
    }

    // Reverse lookup by gml_id to get the UUID
    const listed = await api<{ entities: Array<{ id: string; properties: Record<string, unknown> }> }>(
      `/entities?type=building_lod2&sort=createdAt:desc&pageSize=5`,
    );
    const match = listed.entities.find((e) => e.properties?.gml_id === rec.gmlId);
    if (!match?.id) {
      console.log(`  [FAIL] Building ${shortId}: created but not found in list query`);
      bldgFail++;
      continue;
    }
    const buildingUuid = match.id;
    bldgCount++;
    console.log(
      `  ✓ [${i + 1}/${toImport.length}] Building ${shortId} → ${buildingUuid.slice(0, 8)}… ` +
        `(${rec.surfaces.length} surfaces${rec.measuredHeight ? `, h=${rec.measuredHeight}m` : ""})`,
    );

    // b) Surfaces
    for (const surf of rec.surfaces) {
      try {
        await api("/proposals", {
          method: "POST",
          body: JSON.stringify({
            proposedChange: {
              action: "create",
              data: {
                type: "boundary_surface",
                properties: {
                  gml_id: surf.gmlId,
                  parent_gml_id: rec.gmlId,
                  building_id: buildingUuid,
                  surface_type: surf.surfaceType,
                  material_color: SURFACE_COLOR[surf.surfaceType],
                  geometry: surf.geometry3D,
                },
              },
            },
          }),
        });
        surfCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    [FAIL] ${surf.surfaceType} ${surf.gmlId.slice(0, 12)}: ${msg.slice(0, 160)}`);
        surfFail++;
      }
    }
  }

  console.log(`\nDone.`);
  console.log(`  Buildings: ${bldgCount} created, ${bldgFail} failed`);
  console.log(`  Surfaces:  ${surfCount} created, ${surfFail} failed`);
  console.log(`  Workspace: ${WORKSPACE}`);
}

main()
  .catch((err) => {
    console.error("\n✗ Seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
