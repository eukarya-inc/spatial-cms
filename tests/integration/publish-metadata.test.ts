/**
 * Test: Publish channels, field projection, DCAT metadata.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase, createTestModel, setAutoApproval, prisma } from "../helpers/setup.js";

describe("Publish channels, field projection, metadata", () => {
  let modelKey: string;
  let modelId: string;
  let datasetId: string;

  before(async () => {
    await startServer();
    await cleanDatabase();
    const model = await createTestModel();
    modelKey = model.key;
    modelId = model.id;
    await setAutoApproval(modelId);

    // Create entities
    for (let i = 0; i < 3; i++) {
      await apiRequest("/proposals", {
        method: "POST",
        body: {
          proposedChange: {
            action: "create",
            data: {
              type: modelKey,
              properties: { name: `Building ${i}`, height: (i + 1) * 10, location: { type: "Point", coordinates: [139.7 + i * 0.01, 35.6] } },
            },
          },
        },
      });
    }

    // Create dataset + binding + publish
    const { data: ds } = await apiRequest("/datasets", {
      method: "POST",
      body: { name: "Metadata Test DS" },
    });
    datasetId = ds.id;

    await apiRequest(`/definitions/datasets/${datasetId}/bindings`, {
      method: "POST",
      body: { modelDefinitionId: modelId },
    });

    const { data: snap } = await apiRequest(`/datasets/${datasetId}/snapshot`, {
      method: "POST",
    });
    await apiRequest("/publications/publish", {
      method: "POST",
      body: { datasetSnapshotId: snap.id },
    });
  });

  after(async () => {
    await stopServer();
  });

  // ─── Publish Channels ───

  it("should list dataset in delivery by default", async () => {
    const { data } = await apiRequest("/delivery/datasets");
    assert.ok(data.some((d: any) => d.id === datasetId));
  });

  it("should not list dataset in OGC by default (publishToOgc=false)", async () => {
    const { data } = await apiRequest("/ogc/collections");
    assert.strictEqual(data.collections.length, 0);
  });

  it("should list in OGC after enabling publishToOgc", async () => {
    await apiRequest(`/datasets/${datasetId}`, {
      method: "PUT",
      body: { publishToOgc: true },
    });
    const { data } = await apiRequest("/ogc/collections");
    assert.ok(data.collections.length > 0);
    assert.ok(data.collections[0].id.includes(modelKey));
  });

  it("should hide from delivery after disabling publishToDelivery", async () => {
    await apiRequest(`/datasets/${datasetId}`, {
      method: "PUT",
      body: { publishToDelivery: false },
    });
    const { data } = await apiRequest("/delivery/datasets");
    assert.ok(!data.some((d: any) => d.id === datasetId));

    // Re-enable for later tests
    await apiRequest(`/datasets/${datasetId}`, {
      method: "PUT",
      body: { publishToDelivery: true },
    });
  });

  // ─── Delivery Model Layer ───

  it("should list models in dataset via delivery", async () => {
    const { data } = await apiRequest(`/delivery/datasets/${datasetId}/models`);
    assert.ok(Array.isArray(data));
    assert.strictEqual(data[0].key, modelKey);
    assert.ok(data[0].crs);
  });

  it("should return entities by model key", async () => {
    const { data } = await apiRequest(`/delivery/datasets/${datasetId}/models/${modelKey}/entities?pageSize=10`);
    assert.strictEqual(data.pagination.total, 3);
  });

  // ─── Field Projection ───

  it("should apply field projection on snapshot", async () => {
    // Get binding ID
    const bindings = await prisma.datasetModelBinding.findMany({
      where: { datasetDefinitionId: datasetId },
    });
    const bindingId = bindings[0].id;

    // Set projection: include only "name" (exclude "height")
    await apiRequest(`/definitions/datasets/${datasetId}/bindings/${bindingId}`, {
      method: "PUT",
      body: { projectionJson: { mode: "include", fields: ["name"] } },
    });

    // Regenerate + republish
    const { data: snap } = await apiRequest(`/datasets/${datasetId}/snapshot`, { method: "POST" });
    await apiRequest("/publications/publish", {
      method: "POST",
      body: { datasetSnapshotId: snap.id },
    });

    // Check entity properties only have "name"
    const { data } = await apiRequest(`/delivery/datasets/${datasetId}/entities?pageSize=1`);
    const props = data.entities[0].properties;
    assert.ok(props.name);
    assert.strictEqual(props.height, undefined);
  });

  it("should filter schema fields by projection", async () => {
    const { data } = await apiRequest(`/delivery/datasets/${datasetId}/models/${modelKey}/schema`);
    const fieldKeys = data.fields.map((f: any) => f.key);
    assert.ok(fieldKeys.includes("name"));
    assert.ok(!fieldKeys.includes("height"));
  });

  // ─── DCAT Metadata ───

  it("should save and return dataset metadata", async () => {
    await apiRequest(`/datasets/${datasetId}`, {
      method: "PUT",
      body: {
        description: "Test dataset",
        license: "CC-BY-4.0",
        source: "Unit Test",
        contactName: "Tester",
        contactEmail: "test@example.com",
        keywords: ["test", "spatial"],
      },
    });

    const { data } = await apiRequest(`/delivery/datasets/${datasetId}`);
    assert.strictEqual(data.description, "Test dataset");
    assert.strictEqual(data.license, "CC-BY-4.0");
  });

  it("should return DCAT JSON-LD metadata", async () => {
    const { status, data } = await apiRequest(`/delivery/datasets/${datasetId}/metadata`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data["@type"], "Dataset");
    assert.strictEqual(data.title, "Metadata Test DS");
    assert.strictEqual(data.license, "CC-BY-4.0");
    assert.ok(data.identifier);
    assert.ok(data.landingPage);
    assert.ok(data.distribution.length >= 2);
    assert.ok(data.keyword.includes("test"));
  });

  it("should include OGC distribution only when publishToOgc=true", async () => {
    const { data } = await apiRequest(`/delivery/datasets/${datasetId}/metadata`);
    const ogcDist = data.distribution.find((d: any) => d.title.includes("OGC"));
    assert.ok(ogcDist, "Should have OGC distribution (publishToOgc was enabled)");
  });
});
