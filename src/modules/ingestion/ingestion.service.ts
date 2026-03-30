import prisma from "../../db/client.js";
import { setEntityGeometry } from "../../shared/geometry.js";
import {
  validateAgainstModel,
  findModelDefinitionByKey,
} from "../../shared/dynamic-validation.js";

interface ImportEntity {
  type: string;
  properties: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown };
}

interface ImportOptions {
  skipInvalid?: boolean;
}

/**
 * Validate a batch of entities against their model definition.
 * Does NOT write anything to the database.
 */
export async function validateBulk(
  modelKey: string,
  entities: Array<{ properties: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }>,
) {
  const model = await findModelDefinitionByKey(modelKey);
  const modelDefId = model?.id ?? null;

  const errors: Array<{ index: number; errors: string[] }> = [];
  let valid = 0;

  for (let i = 0; i < entities.length; i++) {
    const result = await validateAgainstModel(
      modelDefId,
      entities[i].properties,
      entities[i].geometry ?? null,
    );
    if (result.valid) {
      valid++;
    } else {
      errors.push({ index: i, errors: result.errors });
    }
  }

  return {
    total: entities.length,
    valid,
    invalid: errors.length,
    modelKey,
    modelDefinitionId: modelDefId,
    errors,
  };
}

/**
 * Bulk import with validation and error handling.
 * skipInvalid: true → import valid records, skip invalid ones
 * skipInvalid: false → if any invalid, import nothing
 */
export async function bulkImport(
  entities: ImportEntity[],
  source: "human" | "machine" | "import_" = "import_",
  options: ImportOptions = {},
) {
  const { skipInvalid = false } = options;

  // Resolve modelDefinitionId for each entity type
  const modelCache: Record<string, string | null> = {};
  for (const item of entities) {
    if (!(item.type in modelCache)) {
      const model = await findModelDefinitionByKey(item.type);
      modelCache[item.type] = model?.id ?? null;
    }
  }

  // Validate all entities first
  const validationErrors: Array<{ index: number; errors: string[] }> = [];
  for (let i = 0; i < entities.length; i++) {
    const item = entities[i];
    const modelDefId = modelCache[item.type];
    const result = await validateAgainstModel(
      modelDefId,
      item.properties,
      item.geometry ?? null,
    );
    if (!result.valid) {
      validationErrors.push({ index: i, errors: result.errors });
    }
  }

  // If not skipping invalid and there are errors, abort
  if (!skipInvalid && validationErrors.length > 0) {
    return {
      imported: 0,
      skipped: validationErrors.length,
      total: entities.length,
      errors: validationErrors,
      entities: [],
    };
  }

  // Build set of invalid indices for skipping
  const invalidIndices = new Set(validationErrors.map((e) => e.index));

  // Import valid entities
  const results = [];
  for (let i = 0; i < entities.length; i++) {
    if (invalidIndices.has(i)) continue;

    const item = entities[i];
    const modelDefId = modelCache[item.type] ?? undefined;

    const entity = await prisma.entity.create({
      data: {
        type: item.type,
        modelDefinitionId: modelDefId,
        properties: item.properties,
        status: "active",
      },
    });

    if (item.geometry) {
      await setEntityGeometry(entity.id, item.geometry);
    }

    await prisma.entityVersion.create({
      data: {
        entityId: entity.id,
        versionNumber: 1,
        snapshot: {
          type: item.type,
          modelDefinitionId: modelDefId ?? null,
          properties: item.properties,
          geometry: item.geometry ?? null,
        },
      },
    });

    await prisma.proposal.create({
      data: {
        entityId: entity.id,
        proposedChange: {
          action: "create",
          data: {
            type: item.type,
            properties: item.properties,
            geometry: item.geometry ?? null,
          },
        },
        source,
        status: "approved",
      },
    });

    results.push({ entityId: entity.id, type: item.type });
  }

  return {
    imported: results.length,
    skipped: invalidIndices.size,
    total: entities.length,
    errors: validationErrors,
    entities: results,
  };
}

/**
 * Bulk proposal creation: creates multiple proposals at once.
 */
export async function createProposalSet(
  proposals: Array<{
    entityId?: string;
    proposedChange: {
      action: "create" | "update";
      data: {
        type?: string;
        properties?: Record<string, unknown>;
        geometry?: { type: string; coordinates: unknown };
        status?: "draft" | "active" | "archived";
      };
    };
  }>,
  source: "human" | "machine" | "import_" = "machine",
) {
  const created = await prisma.proposal.createManyAndReturn({
    data: proposals.map((p) => ({
      entityId: p.entityId,
      proposedChange: p.proposedChange as object,
      source,
      status: "pending" as const,
    })),
  });

  return { created: created.length, proposals: created };
}
