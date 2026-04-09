/**
 * Test: Delivery API — pagination, spatial queries, GeoJSON, schema.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import {
  cleanDatabase,
  createTestModel,
  setAutoApproval,
  prisma,
} from "../helpers/setup.js";

describe("Delivery API", () => {
  let datasetId: string;
  let modelKey: string;

  before(async () => {
    await startServer();
    await cleanDatabase();

    // Create model + auto-approval + 5 entities + dataset + publish
    const model = await createTestModel();
    modelKey = model.key;
    await setAutoApproval(model.id);

    const coords = [
      [139.70, 35.60],
      [139.71, 35.61],
      [139.72, 35.62],
      [139.80, 35.70],
      [140.00, 36.00], // far away
    ];
    for (let i = 0; i < 5; i++) {
      await apiRequest("/proposals", {
        method: "POST",
        body: {
          proposedChange: {
            action: "create",
            data: {
              type: modelKey,
              properties: { name: `Building ${i + 1}`, height: (i + 1) * 50, location: { type: "Point", coordinates: coords[i] } },
            },
          },
        },
      });
    }

    // Create dataset + binding + snapshot + publish
    const { data: dataset } = await apiRequest("/datasets", {
      method: "POST",
      body: { name: "Test Dataset" },
    });
    datasetId = dataset.id;

    await apiRequest(`/definitions/datasets/${datasetId}/bindings`, {
      method: "POST",
      body: { modelDefinitionId: model.id },
    });

    const { data: snapshot } = await apiRequest(
      `/datasets/${datasetId}/snapshot`,
      { method: "POST" },
    );
    await apiRequest("/publications/publish", {
      method: "POST",
      body: { datasetSnapshotId: snapshot.id },
    });
  });

  after(async () => {
    await stopServer();
  });

  it("should list published datasets", async () => {
    const { data } = await apiRequest("/delivery/datasets");
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 1);
    assert.strictEqual(data[0].name, "Test Dataset");
  });

  it("should paginate entities", async () => {
    const { data } = await apiRequest(
      `/delivery/datasets/${datasetId}/entities?page=1&pageSize=2`,
    );
    assert.strictEqual(data.pagination.total, 5);
    assert.strictEqual(data.pagination.pageSize, 2);
    assert.strictEqual(data.entities.length, 2);
  });

  it("should filter entities by bbox", async () => {
    // bbox covering only first 3 buildings (139.69-139.73, 35.59-35.63)
    const { data } = await apiRequest(
      `/delivery/datasets/${datasetId}/entities?bbox=139.69,35.59,139.73,35.63`,
    );
    assert.strictEqual(
      data.pagination.total,
      3,
      "Should find 3 buildings in bbox",
    );
  });

  it("should return GeoJSON FeatureCollection", async () => {
    const { data } = await apiRequest(
      `/delivery/datasets/${datasetId}/entities?format=geojson&pageSize=2`,
    );
    assert.strictEqual(data.type, "FeatureCollection");
    assert.ok(Array.isArray(data.features));
    assert.strictEqual(data.features.length, 2);
    assert.strictEqual(data.features[0].type, "Feature");
    assert.ok(data.metadata.total);
  });

  it("should filter entities by property", async () => {
    const { data } = await apiRequest(
      `/delivery/datasets/${datasetId}/entities?filter%5Bname%5D=Building%201`,
    );
    assert.strictEqual(data.pagination.total, 1);
    assert.strictEqual(data.entities[0].properties.name, "Building 1");
  });

  it("should return dataset schema", async () => {
    const { data } = await apiRequest(
      `/delivery/datasets/${datasetId}/schema`,
    );
    assert.strictEqual(data.dataset, "Test Dataset");
    assert.ok(data.models.length >= 1);
    assert.strictEqual(data.models[0].key, modelKey);
    assert.ok(data.models[0].fields.length >= 2);
  });

  it("should return single entity", async () => {
    const { data: list } = await apiRequest(
      `/delivery/datasets/${datasetId}/entities?pageSize=1`,
    );
    const entityId = list.entities[0].id;

    const { data } = await apiRequest(
      `/delivery/datasets/${datasetId}/entities/${entityId}`,
    );
    assert.ok(data.id);
    assert.ok(data.properties);
    assert.ok(data.properties.location, "geometry should be in properties");
  });
});
