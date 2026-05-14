/**
 * Test: Explicit geometryMode invariants (2D / 2.5D / 3D).
 *
 * Validates the new mode-driven schema:
 *  - 2D    rejects Z coords
 *  - 2.5D  rejects Z coords, requires heightFieldKey pointing to a number field
 *  - 3D    requires Z coords on every vertex
 *  - Mode is immutable after field create
 *  - Storage layer enforces ST_Force2D for 2D/2.5D, preserves Z for 3D
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase, prisma } from "../helpers/setup.js";

const POLY_2D = {
  type: "Polygon",
  coordinates: [[[139.7, 35.6], [139.71, 35.6], [139.71, 35.61], [139.7, 35.61], [139.7, 35.6]]],
};
const POLY_3D = {
  type: "Polygon",
  coordinates: [[[139.7, 35.6, 0], [139.71, 35.6, 0], [139.71, 35.61, 20], [139.7, 35.61, 20], [139.7, 35.6, 0]]],
};

describe("Geometry mode invariants", () => {
  let model2DId: string;
  let model25DId: string;
  let model3DId: string;
  let model2DKey: string;
  let model25DKey: string;
  let model3DKey: string;

  before(async () => {
    await startServer();
    await cleanDatabase();

    // ─── 2D model ───────────────────────────────────────────
    const { data: m2D } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "test_park_2d", name: "Test 2D", primaryGeometryField: "boundary" },
    });
    model2DId = m2D.id; model2DKey = m2D.key;
    await apiRequest(`/definitions/models/${model2DId}/fields`, {
      method: "POST",
      body: { key: "name", label: "Name", fieldType: "string", isRequired: true, orderIndex: 0 },
    });
    await apiRequest(`/definitions/models/${model2DId}/fields`, {
      method: "POST",
      body: {
        key: "boundary", label: "Boundary", fieldType: "geometry",
        geometryType: "POLYGON", geometrySrid: 4326, geometryMode: "2D",
        orderIndex: 1,
      },
    });

    // ─── 2.5D model with height field ───────────────────────
    const { data: m25 } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "test_bldg_25d", name: "Test 2.5D", primaryGeometryField: "footprint" },
    });
    model25DId = m25.id; model25DKey = m25.key;
    await apiRequest(`/definitions/models/${model25DId}/fields`, {
      method: "POST",
      body: { key: "name",     label: "Name",      fieldType: "string", isRequired: true, orderIndex: 0 },
    });
    await apiRequest(`/definitions/models/${model25DId}/fields`, {
      method: "POST",
      body: { key: "height_m", label: "Height",    fieldType: "number", orderIndex: 1 },
    });
    await apiRequest(`/definitions/models/${model25DId}/fields`, {
      method: "POST",
      body: { key: "base_m",   label: "Base",      fieldType: "number", orderIndex: 2 },
    });
    await apiRequest(`/definitions/models/${model25DId}/fields`, {
      method: "POST",
      body: {
        key: "footprint", label: "Footprint", fieldType: "geometry",
        geometryType: "POLYGON", geometrySrid: 4326,
        geometryMode: "2.5D", heightFieldKey: "height_m", baseHeightFieldKey: "base_m",
        orderIndex: 3,
      },
    });

    // ─── 3D model ───────────────────────────────────────────
    const { data: m3D } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "test_bldg_3d", name: "Test 3D", primaryGeometryField: "shell" },
    });
    model3DId = m3D.id; model3DKey = m3D.key;
    await apiRequest(`/definitions/models/${model3DId}/fields`, {
      method: "POST",
      body: { key: "name",  label: "Name",  fieldType: "string", isRequired: true, orderIndex: 0 },
    });
    await apiRequest(`/definitions/models/${model3DId}/fields`, {
      method: "POST",
      body: {
        key: "shell", label: "Shell", fieldType: "geometry",
        geometryType: "POLYGON", geometrySrid: 4326, geometryMode: "3D",
        orderIndex: 1,
      },
    });

    // Auto-approve all three models
    await prisma.governancePolicy.updateMany({
      where: { targetType: "model", targetId: { in: [model2DId, model25DId, model3DId] } },
      data: { approvalMode: "auto" },
    });
  });

  after(async () => {
    await stopServer();
  });

  it("rejects 2.5D geometry create without heightFieldKey on the field", async () => {
    const { data: m } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "broken_25d", name: "Broken 2.5D" },
    });
    await apiRequest(`/definitions/models/${m.id}/fields`, {
      method: "POST",
      body: { key: "n", label: "n", fieldType: "string", orderIndex: 0 },
    });
    const { status, data } = await apiRequest(`/definitions/models/${m.id}/fields`, {
      method: "POST",
      body: {
        key: "g", label: "g", fieldType: "geometry",
        geometryType: "POLYGON", geometryMode: "2.5D", orderIndex: 1,
      },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || "", /heightFieldKey/i);
  });

  it("rejects 2.5D heightFieldKey pointing to non-existent field", async () => {
    const { data: m } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "broken_25d_ref", name: "Broken 2.5D ref" },
    });
    const { status, data } = await apiRequest(`/definitions/models/${m.id}/fields`, {
      method: "POST",
      body: {
        key: "g", label: "g", fieldType: "geometry",
        geometryType: "POLYGON", geometryMode: "2.5D",
        heightFieldKey: "no_such_field", orderIndex: 0,
      },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || "", /does not exist/i);
  });

  it("rejects 2.5D heightFieldKey pointing to non-number field", async () => {
    const { data: m } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "broken_25d_type", name: "Broken 2.5D type" },
    });
    await apiRequest(`/definitions/models/${m.id}/fields`, {
      method: "POST",
      body: { key: "name", label: "Name", fieldType: "string", orderIndex: 0 },
    });
    const { status, data } = await apiRequest(`/definitions/models/${m.id}/fields`, {
      method: "POST",
      body: {
        key: "g", label: "g", fieldType: "geometry",
        geometryType: "POLYGON", geometryMode: "2.5D",
        heightFieldKey: "name", orderIndex: 1,
      },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || "", /must be of fieldType "number"/i);
  });

  it("rejects 2D field receiving a Z-bearing geometry", async () => {
    const { status, data } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: { type: model2DKey, properties: { name: "Bad", boundary: POLY_3D } },
        },
      },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || data.details?.[0]?.message || "", /must not contain Z/i);
  });

  it("rejects 2.5D field receiving a Z-bearing geometry", async () => {
    const { status, data } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: { type: model25DKey, properties: { name: "Bad", height_m: 30, footprint: POLY_3D } },
        },
      },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || data.details?.[0]?.message || "", /must not contain Z/i);
  });

  it("rejects 3D field receiving a 2D geometry (no Z)", async () => {
    const { status, data } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: { type: model3DKey, properties: { name: "Bad", shell: POLY_2D } },
        },
      },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || data.details?.[0]?.message || "", /must include a Z value/i);
  });

  it("accepts 2D + 2.5D + 3D when input matches mode", async () => {
    // 2D — plain footprint
    const { data: p1 } = await apiRequest("/proposals", {
      method: "POST",
      body: { proposedChange: { action: "create",
        data: { type: model2DKey, properties: { name: "Park", boundary: POLY_2D } } } },
    });
    assert.strictEqual(p1.status, "approved");

    // 2.5D — footprint + height props
    const { data: p2 } = await apiRequest("/proposals", {
      method: "POST",
      body: { proposedChange: { action: "create",
        data: { type: model25DKey, properties: { name: "Tower", height_m: 80, base_m: 0, footprint: POLY_2D } } } },
    });
    assert.strictEqual(p2.status, "approved");

    // 3D — vertex-Z geometry
    const { data: p3 } = await apiRequest("/proposals", {
      method: "POST",
      body: { proposedChange: { action: "create",
        data: { type: model3DKey, properties: { name: "Roof", shell: POLY_3D } } } },
    });
    assert.strictEqual(p3.status, "approved");
  });

  it("stores 2D/2.5D geometry without Z (ST_Force2D), 3D with Z", async () => {
    const dims = await prisma.$queryRaw<{ field_key: string; ndims: number }[]>`
      SELECT field_key, ST_NDims(geometry) as ndims
      FROM entity_geometry
      WHERE field_key IN ('boundary', 'footprint', 'shell')
      ORDER BY field_key
    `;
    const byKey = Object.fromEntries(dims.map((d) => [d.field_key, d.ndims]));
    assert.strictEqual(byKey.boundary, 2, "2D field stored as 2D");
    assert.strictEqual(byKey.footprint, 2, "2.5D field stored as 2D (Z stripped, height in props)");
    assert.strictEqual(byKey.shell, 3, "3D field stored as 3D (Z preserved)");
  });

  it("makes geometryMode immutable after create", async () => {
    // Try to update the 2D field's mode to 3D — should fail
    const field = await prisma.fieldDefinition.findFirst({
      where: { modelDefinitionId: model2DId, key: "boundary" },
    });
    assert.ok(field);
    const { status, data } = await apiRequest(`/definitions/models/${model2DId}/fields/${field!.id}`, {
      method: "PUT",
      body: { geometryMode: "3D" },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error || "", /immutable/i);
  });
});
