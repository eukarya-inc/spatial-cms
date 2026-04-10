/**
 * Test: Multi-geometry support and field reorder.
 *
 * Verifies that models can have multiple geometry fields, geometry values
 * are stored in entity_geometry table, spatial queries work on any field,
 * and field reorder API persists order.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase, prisma } from "../helpers/setup.js";

describe("Multi-geometry and field reorder", () => {
  let modelId: string;
  let modelKey: string;

  before(async () => {
    await startServer();
    await cleanDatabase();

    // Create a Park model with 3 geometry fields
    const { data: model } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "test_park", name: "Test Park", primaryGeometryField: "boundary" },
    });
    modelId = model.id;
    modelKey = model.key;

    // Add fields
    await apiRequest(`/definitions/models/${modelId}/fields`, {
      method: "POST",
      body: { key: "name", label: "Name", fieldType: "string", isRequired: true, orderIndex: 0 },
    });
    await apiRequest(`/definitions/models/${modelId}/fields`, {
      method: "POST",
      body: { key: "boundary", label: "Boundary", fieldType: "geometry", geometryType: "POLYGON", geometrySrid: 4326, orderIndex: 1 },
    });
    await apiRequest(`/definitions/models/${modelId}/fields`, {
      method: "POST",
      body: { key: "centroid", label: "Centroid", fieldType: "geometry", geometryType: "POINT", geometrySrid: 4326, orderIndex: 2 },
    });
    await apiRequest(`/definitions/models/${modelId}/fields`, {
      method: "POST",
      body: { key: "entrance", label: "Entrance", fieldType: "geometry", geometryType: "POINT", geometrySrid: 4326, orderIndex: 3 },
    });

    // Model creation auto-creates a manual governance policy; update it to auto
    await prisma.governancePolicy.updateMany({
      where: { targetType: "model", targetId: modelId },
      data: { approvalMode: "auto" },
    });
  });

  after(async () => {
    await stopServer();
  });

  it("should create entity with multiple geometry fields", async () => {
    const boundary = {
      type: "Polygon",
      coordinates: [[[139.7, 35.6], [139.71, 35.6], [139.71, 35.61], [139.7, 35.61], [139.7, 35.6]]],
    };
    const centroid = { type: "Point", coordinates: [139.705, 35.605] };
    const entrance = { type: "Point", coordinates: [139.7, 35.605] };

    const { data: proposal } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: {
            type: modelKey,
            properties: { name: "Central Park", boundary, centroid, entrance },
          },
        },
      },
    });
    assert.strictEqual(proposal.status, "approved");

    // Verify entity_geometry table has 3 rows
    const geoRows = await prisma.$queryRaw<{ field_key: string }[]>`
      SELECT field_key FROM entity_geometry WHERE entity_id = (
        SELECT id FROM entity WHERE type = ${modelKey} LIMIT 1
      ) ORDER BY field_key
    `;
    assert.strictEqual(geoRows.length, 3);
    assert.deepStrictEqual(
      geoRows.map((r) => r.field_key),
      ["boundary", "centroid", "entrance"],
    );
  });

  it("should return all geometry fields in entity properties", async () => {
    const { data } = await apiRequest(`/entities?type=${modelKey}`);
    const entity = data.entities[0];

    assert.ok(entity.properties.boundary, "should have boundary");
    assert.ok(entity.properties.centroid, "should have centroid");
    assert.ok(entity.properties.entrance, "should have entrance");
    assert.strictEqual(entity.properties.boundary.type, "Polygon");
    assert.strictEqual(entity.properties.centroid.type, "Point");
    assert.strictEqual(entity.properties.entrance.type, "Point");
  });

  it("should find entity by bbox on primary geometry field", async () => {
    const { data } = await apiRequest(
      `/entities?type=${modelKey}&bbox=139.69,35.59,139.72,35.62`,
    );
    assert.strictEqual(data.entities.length, 1, "should find entity by boundary bbox");
  });

  it("should update a single geometry field without affecting others", async () => {
    const { data: list } = await apiRequest(`/entities?type=${modelKey}`);
    const entityId = list.entities[0].id;

    const newEntrance = { type: "Point", coordinates: [139.71, 35.61] };
    const { data: proposal } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        entityId,
        proposedChange: {
          action: "update",
          data: { properties: { entrance: newEntrance } },
        },
      },
    });
    assert.strictEqual(proposal.status, "approved");

    // Verify entrance updated, others unchanged
    const { data: entity } = await apiRequest(`/entities/${entityId}`);
    assert.deepStrictEqual(entity.properties.entrance.coordinates, [139.71, 35.61]);
    assert.strictEqual(entity.properties.boundary.type, "Polygon", "boundary should be preserved");
    assert.strictEqual(entity.properties.centroid.type, "Point", "centroid should be preserved");
  });

  it("should preserve geometry in version snapshots", async () => {
    const { data: list } = await apiRequest(`/entities?type=${modelKey}`);
    const entityId = list.entities[0].id;

    const { data: versions } = await apiRequest(`/entities/${entityId}/versions`);
    const latest = versions[0];
    assert.ok(latest.snapshot.properties.boundary, "snapshot should have boundary");
    assert.ok(latest.snapshot.properties.centroid, "snapshot should have centroid");
    assert.ok(latest.snapshot.properties.entrance, "snapshot should have entrance");
  });

  it("should reorder fields via PUT /fields/reorder", async () => {
    // Get current field order
    const { data: before } = await apiRequest(`/definitions/models/${modelId}/schema`);
    const keysBefore = before.fields.map((f: { key: string }) => f.key);

    // Reverse order
    const reversed = [...keysBefore].reverse();
    const { status } = await apiRequest(`/definitions/models/${modelId}/fields/reorder`, {
      method: "PUT",
      body: { order: reversed },
    });
    assert.strictEqual(status, 200);

    // Verify new order
    const { data: after } = await apiRequest(`/definitions/models/${modelId}/schema`);
    const keysAfter = after.fields.map((f: { key: string }) => f.key);
    assert.deepStrictEqual(keysAfter, reversed);
  });

  it("should cascade delete entity_geometry when entity is purged", async () => {
    const { data: list } = await apiRequest(`/entities?type=${modelKey}`);
    const entityId = list.entities[0].id;

    // Archive first (delete action archives via auto-approved proposal)
    const { data: delProp } = await apiRequest("/proposals", {
      method: "POST",
      body: { entityId, proposedChange: { action: "delete", data: {} } },
    });
    // createProposal returns the proposal; for auto-approved it may have status or nested
    const delStatus = delProp.status || delProp.proposal?.status;
    assert.strictEqual(delStatus, "approved", `delete proposal should be auto-approved: ${JSON.stringify(delProp)}`);

    // Purge
    const { status, data: purgeResult } = await apiRequest(`/entities/${entityId}/purge`, { method: "DELETE" });
    assert.strictEqual(status, 200, `purge should succeed: ${JSON.stringify(purgeResult)}`);

    // Verify entity_geometry rows are gone
    const remaining = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) as count FROM entity_geometry WHERE entity_id = ${entityId}::uuid
    `;
    assert.strictEqual(Number(remaining[0].count), 0);
  });
});
