import prisma from "../../db/client.js";
import { setEntityGeometry } from "../../shared/geometry.js";
import {
  validateAgainstModel,
  findModelDefinitionByKey,
} from "../../shared/dynamic-validation.js";
import { createProposal } from "../proposal/proposal.service.js";

interface ImportEntity {
  type: string;
  properties: Record<string, unknown>;
}

interface ImportOptions {
  skipInvalid?: boolean;
}

/**
 * Validate a batch of entities against their model definition.
 * Does NOT write anything to the database.
 */
export async function validateBulk(
  workspaceId: string,
  modelKey: string,
  entities: Array<{ properties: Record<string, unknown> }>,
) {
  const model = await findModelDefinitionByKey(workspaceId, modelKey);
  const modelDefId = model?.id ?? null;

  const errors: Array<{ index: number; errors: string[] }> = [];
  let valid = 0;

  for (let i = 0; i < entities.length; i++) {
    const result = await validateAgainstModel(
      modelDefId,
      entities[i].properties,
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
  workspaceId: string,
  entities: ImportEntity[],
  source: "human" | "machine" | "import_" = "import_",
  options: ImportOptions = {},
) {
  const { skipInvalid = false } = options;

  // Resolve modelDefinitionId for each entity type (scoped to workspace)
  const modelCache: Record<string, string | null> = {};
  for (const item of entities) {
    if (!(item.type in modelCache)) {
      const model = await findModelDefinitionByKey(workspaceId, item.type);
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
        properties: item.properties as any,
        status: "active",
      },
    });

    // Extract primaryGeometryField value from properties and sync to PostGIS column
    if (modelDefId) {
      const model = await prisma.modelDefinition.findUnique({ where: { id: modelDefId } });
      if (model?.primaryGeometryField) {
        const geoValue = item.properties[model.primaryGeometryField];
        if (geoValue && typeof geoValue === "object" && "type" in (geoValue as object) && "coordinates" in (geoValue as object)) {
          const geoField = await prisma.fieldDefinition.findUnique({
            where: { modelDefinitionId_key: { modelDefinitionId: modelDefId, key: model.primaryGeometryField } },
          });
          const srid = geoField?.geometrySrid ?? 4326;
          await setEntityGeometry(entity.id, model.primaryGeometryField, geoValue as { type: string; coordinates: unknown }, srid);
        }
      }
    }

    // Snapshot stores all properties (geometry values are inside properties)
    await prisma.entityVersion.create({
      data: {
        entityId: entity.id,
        versionNumber: 1,
        snapshot: ({
          type: item.type,
          modelDefinitionId: modelDefId ?? null,
          properties: item.properties,
        }) as any,
      },
    });

    await prisma.proposal.create({
      data: {
        entityId: entity.id,
        proposedChange: ({
          action: "create",
          data: {
            type: item.type,
            properties: item.properties,
          },
        }) as any,
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
  workspaceId: string,
  proposals: Array<{
    entityId?: string;
    proposedChange: {
      action: "create" | "update";
      data: {
        type?: string;
        properties?: Record<string, unknown>;
        status?: "draft" | "active" | "archived";
      };
    };
  }>,
  source: "human" | "machine" | "import_" = "machine",
) {
  // Verify all proposal types are in this workspace (best-effort: skips ones with no type)
  const types = [
    ...new Set(
      proposals
        .map((p) => p.proposedChange?.data?.type)
        .filter((t): t is string => !!t),
    ),
  ];
  for (const t of types) {
    const m = await findModelDefinitionByKey(workspaceId, t);
    if (!m) throw new Error(`Model "${t}" not found in this workspace`);
  }

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

/**
 * Governed import: creates proposals through the normal governance pipeline.
 * - Models with approvalMode=auto → auto-approved, entities created immediately
 * - Models with approvalMode=manual → proposals stay pending for review
 * This is the recommended import mode for data pipelines.
 */
export async function governedImport(
  workspaceId: string,
  entities: ImportEntity[],
  source: "human" | "machine" | "import_" = "machine",
  options: ImportOptions = {},
) {
  const { skipInvalid = false } = options;

  // Resolve model for validation (scoped to workspace)
  const modelCache: Record<string, string | null> = {};
  for (const item of entities) {
    if (!(item.type in modelCache)) {
      const model = await findModelDefinitionByKey(workspaceId, item.type);
      modelCache[item.type] = model?.id ?? null;
    }
  }

  // Validate first
  const validationErrors: Array<{ index: number; errors: string[] }> = [];
  for (let i = 0; i < entities.length; i++) {
    const result = await validateAgainstModel(
      modelCache[entities[i].type],
      entities[i].properties,
    );
    if (!result.valid) {
      validationErrors.push({ index: i, errors: result.errors });
    }
  }

  if (!skipInvalid && validationErrors.length > 0) {
    return {
      approved: 0,
      pending: 0,
      skipped: validationErrors.length,
      total: entities.length,
      errors: validationErrors,
      results: [],
    };
  }

  const invalidIndices = new Set(validationErrors.map((e) => e.index));
  const results: Array<{ index: number; status: string; proposalId: string }> = [];
  let approved = 0;
  let pending = 0;

  for (let i = 0; i < entities.length; i++) {
    if (invalidIndices.has(i)) continue;
    const item = entities[i];

    // Use createProposal which handles auto-approval via GovernancePolicy
    try {
      const proposal = await createProposal(workspaceId, {
        proposedChange: {
          action: "create",
          data: {
            type: item.type,
            properties: item.properties,
          },
        },
        source,
      });

      if (proposal.status === "approved") {
        approved++;
      } else {
        pending++;
      }
      results.push({ index: i, status: proposal.status, proposalId: proposal.id });
    } catch (err: any) {
      validationErrors.push({ index: i, errors: [err.message || "Failed to create proposal"] });
      if (!skipInvalid) {
        return { approved, pending, skipped: invalidIndices.size + 1, total: entities.length, errors: validationErrors, results };
      }
    }
  }

  return {
    approved,
    pending,
    skipped: invalidIndices.size,
    total: entities.length,
    errors: validationErrors,
    results,
  };
}
