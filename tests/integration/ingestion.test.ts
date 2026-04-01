/**
 * Test: Ingestion API — validate, import, governed import.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { startServer, stopServer, apiRequest } from "../helpers/api.js";
import {
  cleanDatabase,
  createTestModel,
  setAutoApproval,
} from "../helpers/setup.js";

describe("Ingestion API", () => {
  let modelId: string;
  let modelKey: string;

  before(async () => {
    await startServer();
    await cleanDatabase();
    const model = await createTestModel();
    modelId = model.id;
    modelKey = model.key;
  });

  after(async () => {
    await stopServer();
  });

  it("should validate entities and report errors", async () => {
    const { data } = await apiRequest("/ingestion/validate", {
      method: "POST",
      body: {
        modelKey: modelKey,
        entities: [
          { properties: { name: "Valid", height: 100 } },
          { properties: { height: "not_a_number" } }, // missing name + wrong type
          { properties: { name: "Also Valid" } },
        ],
      },
    });
    assert.strictEqual(data.total, 3);
    assert.strictEqual(data.valid, 2);
    assert.strictEqual(data.invalid, 1);
    assert.strictEqual(data.errors[0].index, 1);
  });

  it("should import with skipInvalid=true", async () => {
    const { data } = await apiRequest("/ingestion/import", {
      method: "POST",
      body: {
        entities: [
          {
            type: modelKey,
            properties: { name: "Good 1", height: 50 },
          },
          {
            type: modelKey,
            properties: { height: 999 }, // missing required name
          },
          {
            type: modelKey,
            properties: { name: "Good 2", height: 75 },
          },
        ],
        options: { skipInvalid: true },
      },
    });
    assert.strictEqual(data.imported, 2);
    assert.strictEqual(data.skipped, 1);
  });

  it("should reject all when skipInvalid=false and errors exist", async () => {
    const { data } = await apiRequest("/ingestion/import", {
      method: "POST",
      body: {
        entities: [
          {
            type: modelKey,
            properties: { name: "OK" },
          },
          {
            type: modelKey,
            properties: { height: 100 }, // missing name
          },
        ],
        options: { skipInvalid: false },
      },
    });
    assert.strictEqual(data.imported, 0, "Should import nothing");
    assert.strictEqual(data.skipped, 1);
  });

  it("should auto-approve via governed import", async () => {
    await setAutoApproval(modelId);

    const { data } = await apiRequest("/ingestion/governed", {
      method: "POST",
      body: {
        entities: [
          {
            type: modelKey,
            properties: { name: "Governed 1" },
          },
          {
            type: modelKey,
            properties: { name: "Governed 2" },
          },
        ],
        source: "machine",
      },
    });
    assert.strictEqual(data.approved, 2);
    assert.strictEqual(data.pending, 0);
  });

  it("should create pending proposals when no auto-approval policy", async () => {
    // Clean the governance policy first
    const { prisma } = await import("../helpers/setup.js");
    await prisma.governancePolicy.deleteMany({
      where: { targetId: modelId },
    });

    const { data } = await apiRequest("/ingestion/governed", {
      method: "POST",
      body: {
        entities: [
          {
            type: modelKey,
            properties: { name: "Manual 1" },
          },
        ],
        source: "machine",
      },
    });
    assert.strictEqual(data.approved, 0);
    assert.strictEqual(data.pending, 1);
  });
});
