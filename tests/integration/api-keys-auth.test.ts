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
      body: { modelDefinitionId: (await prisma.modelDefinition.findFirst({ where: { key: modelKey } }))?.id },
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

  it("should allow manage key to read definitions (GET)", async () => {
    const { status } = await apiRequest("/definitions/models", {
      headers: { "X-API-Key": manageKey },
    });
    assert.strictEqual(status, 200);
  });

  it("should reject manage key on definitions write (POST)", async () => {
    const { status } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "test_scope_fail", name: "Should Fail" },
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

  // ─── Workspace isolation (per-key workspace_id) ─────────────────────

  it("bootstrap admin key is bound to the default workspace", async () => {
    const ws = await prisma.workspace.findUnique({ where: { slug: "default" } });
    const key = await prisma.apiKey.findFirst({ where: { name: "Admin (bootstrap)" } });
    assert.ok(key, "bootstrap key should exist");
    assert.strictEqual(key!.workspaceId, ws!.id, "bootstrap key bound to default ws");
  });

  it("rejects an API key when used against a different workspace", async () => {
    // Create another workspace
    const { data: otherWs } = await apiRequest("/workspaces", {
      method: "POST",
      body: { slug: "ws_isolation_test", name: "Iso Test" },
      headers: { "X-API-Key": adminKey },
    });
    assert.ok(otherWs.id, "should create other ws");

    // adminKey is bound to default workspace. Try to use it against ws_isolation_test.
    const { status } = await apiRequest("/entities?pageSize=1", {
      headers: { "X-API-Key": adminKey, "X-Workspace-Key": "ws_isolation_test" },
    });
    assert.strictEqual(status, 403, "cross-workspace use must be blocked");

    // Cleanup
    await apiRequest("/workspaces/ws_isolation_test", {
      method: "DELETE",
      headers: { "X-API-Key": adminKey },
    });
  });

  it("GET /api-keys only returns keys in caller's workspace", async () => {
    // /api-keys requires admin scope. Inject a key for ANOTHER workspace via DB,
    // then confirm GET /api-keys (called with default-bound admin key) does NOT include it.
    const other = await prisma.workspace.create({
      data: { slug: "ws_list_iso", name: "List Iso" },
    });
    const otherKey = await prisma.apiKey.create({
      data: {
        name: "Hidden key (other ws)",
        keyHash: "hidden-key-hash-" + Date.now(),
        keyPrefix: "scms_hidden",
        scope: "admin",
        workspaceId: other.id,
      },
    });

    const { status, data } = await apiRequest("/api-keys", {
      headers: { "X-API-Key": adminKey },
    });
    assert.strictEqual(status, 200);
    const ws = await prisma.workspace.findUnique({ where: { slug: "default" } });
    for (const k of data) {
      assert.strictEqual(k.workspaceId, ws!.id, `key ${k.name} should be in default ws`);
    }
    // The hidden cross-workspace key must NOT appear
    assert.ok(!data.some((k: any) => k.id === otherKey.id), "cross-workspace key leaked");

    // Cleanup
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("DELETE /api-keys/:id refuses cross-workspace keys (returns 404)", async () => {
    // Create another workspace + a key for it via direct prisma (simulating someone else's key)
    const other = await prisma.workspace.create({
      data: { slug: "ws_del_other", name: "Other for delete test" },
    });
    const otherKey = await prisma.apiKey.create({
      data: {
        name: "Other ws key",
        keyHash: "other-key-hash-" + Date.now(),
        keyPrefix: "scms_otherx",
        scope: "delivery",
        workspaceId: other.id,
      },
    });

    // Try to delete that key using our default-workspace admin key — should 404
    const { status } = await apiRequest(`/api-keys/${otherKey.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": adminKey },
    });
    assert.strictEqual(status, 404);

    // Cleanup
    await prisma.workspace.delete({ where: { id: other.id } });
  });
});
