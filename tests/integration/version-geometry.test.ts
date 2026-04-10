/**
 * Test: Version snapshots preserve geometry correctly.
 *
 * Geometry is now a field type stored in properties (e.g. properties.location).
 * The primary geometry field's value is also synced to the PostGIS column
 * for spatial indexing. This test verifies snapshots preserve geometry
 * through status-only and properties-only updates.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import {
  cleanDatabase,
  createTestModel,
  setAutoApproval,
} from "../helpers/setup.js";

describe("Version snapshot geometry preservation", () => {
  let baseUrl: string;
  let modelId: string;
  let modelKey: string;

  before(async () => {
    baseUrl = await startServer();
    await cleanDatabase();
    const model = await createTestModel();
    modelId = model.id;
    modelKey = model.key;
    await setAutoApproval(modelId);
  });

  after(async () => {
    await stopServer();
  });

  it("should include geometry in initial version snapshot", async () => {
    // Create entity with geometry in properties (auto-approved)
    const { data: proposal } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: {
            type: modelKey,
            properties: {
              name: "Tower A",
              height: 100,
              location: { type: "Point", coordinates: [139.7, 35.6] },
            },
          },
        },
      },
    });
    assert.strictEqual(proposal.status, "approved");

    const { data: entitiesResult } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entitiesResult.entities[0].id;

    // Check version snapshot has geometry in properties
    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    assert.strictEqual(versions.length, 1);
    assert.ok(
      versions[0].snapshot.properties.location,
      "v1 snapshot should have location geometry in properties",
    );
    assert.strictEqual(versions[0].snapshot.properties.location.type, "Point");
  });

  it("should preserve geometry when only status is updated", async () => {
    const { data: entitiesResult } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entitiesResult.entities[0].id;

    // Update status only (no geometry change)
    const { data: statusProp } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        entityId,
        proposedChange: {
          action: "update",
          data: { status: "archived" },
        },
      },
    });
    assert.strictEqual(statusProp.status, "approved");

    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    const latest = versions[0];
    assert.ok(
      latest.snapshot.properties.location,
      "Snapshot should preserve geometry after status-only update",
    );
    assert.strictEqual(latest.snapshot.properties.location.type, "Point");
    assert.deepStrictEqual(latest.snapshot.properties.location.coordinates, [139.7, 35.6]);
  });

  it("should preserve geometry when only properties are updated", async () => {
    const { data: entitiesResult } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entitiesResult.entities[0].id;

    // Update non-geometry properties only
    const { data: propProp } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        entityId,
        proposedChange: {
          action: "update",
          data: { properties: { name: "Tower A Renamed", height: 150 } },
        },
      },
    });
    assert.strictEqual(propProp.status, "approved");

    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    const latest = versions[0];
    assert.ok(
      latest.snapshot.properties.location,
      "Snapshot should preserve geometry after properties-only update",
    );
    assert.strictEqual(latest.snapshot.properties.name, "Tower A Renamed");
  });

  it("should update geometry in snapshot when geometry is changed", async () => {
    const { data: entitiesResult } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entitiesResult.entities[0].id;

    // Update geometry via properties
    const { data: geoProp } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        entityId,
        proposedChange: {
          action: "update",
          data: {
            properties: {
              location: { type: "Point", coordinates: [140.0, 36.0] },
            },
          },
        },
      },
    });
    assert.strictEqual(geoProp.status, "approved");

    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    const latest = versions[0];
    assert.ok(latest.snapshot.properties.location);
    assert.deepStrictEqual(latest.snapshot.properties.location.coordinates, [140.0, 36.0]);
  });
});
