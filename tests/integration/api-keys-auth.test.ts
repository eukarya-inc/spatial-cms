/**
 * Test: API Key scope system + auth middleware.
 * Runs with DELIVERY_API_KEY_REQUIRED=true to test real auth behavior.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase, createTestModel, setAutoApproval, prisma } from "../helpers/setup.js";

// Override env for this test suite
process.env.DELIVERY_API_KEY_REQUIRED = "true";

describe("API Key auth and scopes", () => {
  let modelKey: string;
  let adminKey: string;
  let manageKey: string;
  let deliveryKey: string;

  before(async () => {
    await startServer();
    await cleanDatabase();
    const model = await createTestModel();
    modelKey = model.key;
    await setAutoApproval(model.id);

    // Create entity + dataset + publish for delivery tests
    const { data: prop } = await apiRequest("/proposals", {
      method: "POST",
      body: {
        proposedChange: {
          action: "create",
          data: { type: modelKey, properties: { name: "Auth Test" } },
        },
      },
    });

    // Bootstrap admin key
    const { data: bootstrap } = await apiRequest("/api-keys/bootstrap", { method: "POST" });
    adminKey = bootstrap.key;

    // Create manage + delivery keys using admin key
    const { data: mk } = await apiRequest("/api-keys", {
      method: "POST",
      body: { name: "Test Manage", scope: "manage" },
      headers: { "X-API-Key": adminKey },
    });
    manageKey = mk.key;

    const { data: dk } = await apiRequest("/api-keys", {
      method: "POST",
      body: { name: "Test Delivery", scope: "delivery" },
      headers: { "X-API-Key": adminKey },
    });
    deliveryKey = dk.key;
  });

  after(async () => {
    process.env.DELIVERY_API_KEY_REQUIRED = "false";
    await stopServer();
  });

  it("should reject requests without auth", async () => {
    const { status } = await apiRequest("/entities?pageSize=1");
    assert.strictEqual(status, 401);
  });

  it("should allow delivery key to access delivery API", async () => {
    // Need a published dataset first
    const { data: ds } = await apiRequest("/datasets", {
      method: "POST",
      body: { name: "Auth Test DS" },
      headers: { "X-API-Key": adminKey },
    });
    const { data: binding } = await apiRequest(`/definitions/datasets/${ds.id}/bindings`, {
      method: "POST",
      body: { modelDefinitionId: (await prisma.modelDefinition.findUnique({ where: { key: modelKey } }))?.id },
      headers: { "X-API-Key": adminKey },
    });
    const { data: snap } = await apiRequest(`/datasets/${ds.id}/snapshot`, {
      method: "POST",
      headers: { "X-API-Key": adminKey },
    });
    await apiRequest("/publications/publish", {
      method: "POST",
      body: { datasetSnapshotId: snap.id },
      headers: { "X-API-Key": adminKey },
    });

    const { status } = await apiRequest(`/delivery/datasets`, {
      headers: { "X-API-Key": deliveryKey },
    });
    assert.strictEqual(status, 200);
  });

  it("should reject delivery key on management API", async () => {
    const { status } = await apiRequest("/entities?pageSize=1", {
      headers: { "X-API-Key": deliveryKey },
    });
    assert.strictEqual(status, 403);
  });

  it("should allow manage key on management API", async () => {
    const { status } = await apiRequest("/entities?pageSize=1", {
      headers: { "X-API-Key": manageKey },
    });
    assert.strictEqual(status, 200);
  });

  it("should reject manage key on definitions API", async () => {
    const { status } = await apiRequest("/definitions/models", {
      headers: { "X-API-Key": manageKey },
    });
    assert.strictEqual(status, 403);
  });

  it("should allow admin key on definitions API", async () => {
    const { status } = await apiRequest("/definitions/models", {
      headers: { "X-API-Key": adminKey },
    });
    assert.strictEqual(status, 200);
  });

  it("should allow OGC without any auth", async () => {
    const { status } = await apiRequest("/ogc/");
    assert.strictEqual(status, 200);
  });

  it("should reject bootstrap when keys already exist", async () => {
    const { status } = await apiRequest("/api-keys/bootstrap", { method: "POST" });
    assert.strictEqual(status, 403);
  });

  it("should list keys (admin only)", async () => {
    const { status, data } = await apiRequest("/api-keys", {
      headers: { "X-API-Key": adminKey },
    });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 3);
    // Should not expose full key hash
    assert.ok(!data[0].keyHash);
  });

  it("should revoke a key", async () => {
    // Create a throwaway key
    const { data: temp } = await apiRequest("/api-keys", {
      method: "POST",
      body: { name: "To Revoke", scope: "delivery" },
      headers: { "X-API-Key": adminKey },
    });

    // Revoke it
    const { status } = await apiRequest(`/api-keys/${temp.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": adminKey },
    });
    assert.strictEqual(status, 200);

    // Revoked key should not work
    const { status: s2 } = await apiRequest("/delivery/datasets", {
      headers: { "X-API-Key": temp.key },
    });
    assert.strictEqual(s2, 403);
  });
});
