/**
 * Test: model update validation, in particular displayField pointing at a
 * real field on the model. Without this check, the API silently accepted
 * arbitrary strings — the PLATEAU LOD2 seed exposed this when boundary_surface
 * was saved with displayField="surface_type" (an enum_ field), but the Model
 * Designer dropdown filtered enum_ out so the persisted value diverged from
 * what the user saw.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import { cleanDatabase } from "../helpers/setup.js";

describe("Model update validation", () => {
  let modelId: string;

  before(async () => {
    await startServer();
    await cleanDatabase();

    const { data: model } = await apiRequest("/definitions/models", {
      method: "POST",
      body: { key: "test_thing", name: "Test Thing" },
    });
    modelId = model.id;

    await apiRequest(`/definitions/models/${modelId}/fields`, {
      method: "POST",
      body: { key: "name", label: "Name", fieldType: "string", isRequired: true, orderIndex: 0 },
    });
    await apiRequest(`/definitions/models/${modelId}/fields`, {
      method: "POST",
      body: { key: "category", label: "Category", fieldType: "enum_", enumValues: ["a", "b"], orderIndex: 1 },
    });
  });

  after(async () => {
    await stopServer();
  });

  it("accepts displayField that points at an existing field (string)", async () => {
    const { status, data } = await apiRequest(`/definitions/models/${modelId}`, {
      method: "PUT",
      body: { displayField: "name" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.displayField, "name");
  });

  it("accepts displayField that points at an enum field", async () => {
    const { status, data } = await apiRequest(`/definitions/models/${modelId}`, {
      method: "PUT",
      body: { displayField: "category" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.displayField, "category");
  });

  it("rejects displayField that does not match any field on the model", async () => {
    const { status, data } = await apiRequest(`/definitions/models/${modelId}`, {
      method: "PUT",
      body: { displayField: "nope_not_a_field" },
    });
    assert.strictEqual(status, 400);
    assert.match(data.error, /displayField.*existing field/);
  });
});
