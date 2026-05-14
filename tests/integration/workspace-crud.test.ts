/**
 * Test: Workspace rename (PATCH /workspaces/:slug).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase, prisma } from "../helpers/setup.js";

describe("Workspace rename", () => {
  const testSlug = "rename_target";

  before(async () => {
    await startServer();
    await cleanDatabase();
    // Test workspace lives outside cleanDatabase's scope; create + clean explicitly.
    await prisma.workspace.deleteMany({ where: { slug: testSlug } });
    await apiRequest("/workspaces", {
      method: "POST",
      body: { slug: testSlug, name: "Original Name", description: "Original desc" },
    });
  });

  after(async () => {
    await prisma.workspace.deleteMany({ where: { slug: testSlug } });
    // Restore default workspace name in case a test changed it.
    await prisma.workspace.update({
      where: { slug: "default" },
      data: { name: "Default", description: null },
    });
    await stopServer();
  });

  it("should rename workspace name", async () => {
    const { status, data } = await apiRequest(`/workspaces/${testSlug}`, {
      method: "PATCH",
      body: { name: "New Name" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.name, "New Name");
    assert.strictEqual(data.slug, testSlug, "slug must not change");
    assert.strictEqual(data.description, "Original desc", "description preserved when not in patch");
  });

  it("should update description (including setting to null)", async () => {
    const { status, data } = await apiRequest(`/workspaces/${testSlug}`, {
      method: "PATCH",
      body: { description: null },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.description, null);
  });

  it("should reject empty body (no name, no description)", async () => {
    const { status } = await apiRequest(`/workspaces/${testSlug}`, {
      method: "PATCH",
      body: {},
    });
    assert.strictEqual(status, 400);
  });

  it("should strip unknown fields like slug (and 400 if nothing valid remains)", async () => {
    const { status, data: before } = await apiRequest(`/workspaces/${testSlug}`);
    const { status: patchStatus } = await apiRequest(`/workspaces/${testSlug}`, {
      method: "PATCH",
      body: { slug: "evil_slug" },
    });
    assert.strictEqual(patchStatus, 400, "slug-only patch should fail .refine check");
    const { data: after } = await apiRequest(`/workspaces/${testSlug}`);
    assert.strictEqual(after.slug, before.slug, "slug must not change");
  });

  it("should 404 when slug does not exist", async () => {
    const { status } = await apiRequest("/workspaces/does_not_exist_xyz", {
      method: "PATCH",
      body: { name: "anything" },
    });
    assert.strictEqual(status, 404);
  });

  it("should allow renaming the default workspace's name", async () => {
    const { status, data } = await apiRequest("/workspaces/default", {
      method: "PATCH",
      body: { name: "上田研究室" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.name, "上田研究室");
    assert.strictEqual(data.slug, "default", "default slug stays default");
  });
});
