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

  it("delivery list is workspace-scoped (returns only this workspace's datasets)", async () => {
    // Delivery API is workspace-scoped via the calling key/header. Test setup uses
    // default workspace; create another workspace + dataset and confirm it doesn't
    // leak into the default-scoped response.
    await prisma.workspace.deleteMany({ where: { slug: "ws_delivery_iso" } });
    const otherWs = await prisma.workspace.create({
      data: { slug: "ws_delivery_iso", name: "Delivery Iso Test" },
    });
    const otherModel = await prisma.modelDefinition.create({
      data: { workspaceId: otherWs.id, key: "iso_model", name: "Iso Model" },
    });
    const otherDs = await prisma.datasetDefinition.create({
      data: { workspaceId: otherWs.id, name: "Iso DS", entityTypes: [], publishToDelivery: true },
    });
    const snap = await prisma.datasetSnapshot.create({
      data: { datasetDefinitionId: otherDs.id, version: 1, manifest: [], status: "published" },
    });
    await prisma.activeReleaseState.create({
      data: { datasetDefinitionId: otherDs.id, activeSnapshotId: snap.id },
    });

    // Call /delivery/datasets with default workspace header (test default).
    // Should NOT include the other workspace's dataset.
    const { data } = await apiRequest("/delivery/datasets");
    const ids = data.map((d: any) => d.id);
    assert.ok(ids.includes(datasetId), "this-workspace dataset is present");
    assert.ok(!ids.includes(otherDs.id), "cross-workspace dataset must NOT appear");

    // Cleanup
    await prisma.activeReleaseState.deleteMany({ where: { datasetDefinitionId: otherDs.id } });
    await prisma.datasetSnapshot.deleteMany({ where: { datasetDefinitionId: otherDs.id } });
    await prisma.datasetDefinition.delete({ where: { id: otherDs.id } });
    await prisma.modelDefinition.delete({ where: { id: otherModel.id } });
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("delivery get-by-id 404s for cross-workspace datasets", async () => {
    await prisma.workspace.deleteMany({ where: { slug: "ws_delivery_iso2" } });
    const otherWs = await prisma.workspace.create({
      data: { slug: "ws_delivery_iso2", name: "Iso 2" },
    });
    const otherModel = await prisma.modelDefinition.create({
      data: { workspaceId: otherWs.id, key: "iso2_model", name: "Iso 2 Model" },
    });
    const otherDs = await prisma.datasetDefinition.create({
      data: { workspaceId: otherWs.id, name: "Iso 2 DS", entityTypes: [], publishToDelivery: true },
    });
    const snap = await prisma.datasetSnapshot.create({
      data: { datasetDefinitionId: otherDs.id, version: 1, manifest: [], status: "published" },
    });
    await prisma.activeReleaseState.create({
      data: { datasetDefinitionId: otherDs.id, activeSnapshotId: snap.id },
    });

    const { status } = await apiRequest(`/delivery/datasets/${otherDs.id}`);
    assert.strictEqual(status, 404, "cross-workspace dataset lookup must 404");

    // Cleanup
    await prisma.activeReleaseState.deleteMany({ where: { datasetDefinitionId: otherDs.id } });
    await prisma.datasetSnapshot.deleteMany({ where: { datasetDefinitionId: otherDs.id } });
    await prisma.datasetDefinition.delete({ where: { id: otherDs.id } });
    await prisma.modelDefinition.delete({ where: { id: otherModel.id } });
    await prisma.workspace.delete({ where: { id: otherWs.id } });
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
