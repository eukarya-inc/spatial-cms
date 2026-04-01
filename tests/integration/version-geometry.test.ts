/**
 * Test: Version snapshots preserve geometry correctly.
 *
 * Regression test for bug where updating only status (without geometry)
 * caused the version snapshot to lose geometry data. Root cause was that
 * geometry is stored in PostGIS via raw SQL outside the Prisma transaction,
 * so the snapshot inside the transaction had geometry: null.
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
    // Create entity with geometry via proposal (auto-approved)
    const { data: proposal } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: {
            type: modelKey,
            properties: { name: "Tower A", height: 100 },
            geometry: { type: "Point", coordinates: [139.7, 35.6] },
          },
        },
      },
    });
    assert.strictEqual(proposal.status, "approved");

    // Get the entity ID from a list query
    const { data: entities } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entities[0].id;

    // Check version snapshot has geometry
    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    assert.strictEqual(versions.length, 1);
    assert.ok(
      versions[0].snapshot.geometry,
      "v1 snapshot should have geometry",
    );
    assert.strictEqual(versions[0].snapshot.geometry.type, "Point");
  });

  it("should preserve geometry when only status is updated", async () => {
    // Get entity
    const { data: entities } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entities[0].id;

    // Update status only (no geometry in the change)
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

    // Check new version snapshot still has geometry
    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    const latest = versions[0]; // most recent first
    assert.ok(
      latest.snapshot.geometry,
      "Version snapshot should preserve geometry after status-only update",
    );
    assert.strictEqual(latest.snapshot.geometry.type, "Point");
    assert.deepStrictEqual(latest.snapshot.geometry.coordinates, [139.7, 35.6]);
  });

  it("should preserve geometry when only properties are updated", async () => {
    const { data: entities } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entities[0].id;

    // Update properties only
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

    // Check version snapshot
    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    const latest = versions[0];
    assert.ok(
      latest.snapshot.geometry,
      "Version snapshot should preserve geometry after properties-only update",
    );
    assert.strictEqual(latest.snapshot.properties.name, "Tower A Renamed");
  });

  it("should update geometry in snapshot when geometry is changed", async () => {
    const { data: entities } = await apiRequest(
      `/entities?type=${modelKey}`,
    );
    const entityId = entities[0].id;

    // Update geometry
    const { data: geoProp } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        entityId,
        proposedChange: {
          action: "update",
          data: {
            geometry: { type: "Point", coordinates: [140.0, 36.0] },
          },
        },
      },
    });
    assert.strictEqual(geoProp.status, "approved");

    // Check new coordinates
    const { data: versions } = await apiRequest(
      `/entities/${entityId}/versions`,
    );
    const latest = versions[0];
    assert.ok(latest.snapshot.geometry);
    assert.deepStrictEqual(latest.snapshot.geometry.coordinates, [140.0, 36.0]);
  });
});
