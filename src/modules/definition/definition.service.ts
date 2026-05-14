import prisma from "../../db/client.js";
import { BusinessError, NotFoundError } from "../../shared/errors.js";

// ─── Model Definition ────────────────────────────────

export async function createModelDefinition(
  workspaceId: string,
  data: {
    key: string;
    name: string;
    description?: string;
    primaryGeometryField?: string;
    displayField?: string;
  },
) {
  const model = await prisma.modelDefinition.create({
    data: {
      workspaceId,
      key: data.key,
      name: data.name,
      description: data.description,
      primaryGeometryField: data.primaryGeometryField,
      displayField: data.displayField,
    },
    include: { fields: true },
  });

  // Auto-create default governance policy (manual approval)
  await prisma.governancePolicy.create({
    data: {
      targetType: "model",
      targetId: model.id,
      approvalMode: "manual",
      publishMode: "manual",
    },
  });

  return model;
}

export async function listModelDefinitions(workspaceId: string) {
  return prisma.modelDefinition.findMany({
    where: { workspaceId },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
      _count: { select: { entities: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getModelDefinition(workspaceId: string, id: string) {
  return prisma.modelDefinition.findFirst({
    where: { id, workspaceId },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
    },
  });
}

export async function updateModelDefinition(
  workspaceId: string,
  id: string,
  data: {
    name?: string;
    description?: string;
    primaryGeometryField?: string | null;
    displayField?: string;
  },
) {
  // Verify ownership; 404 if not in this workspace.
  const existing = await prisma.modelDefinition.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new NotFoundError("Model");

  return prisma.modelDefinition.update({
    where: { id },
    data,
    include: { fields: { orderBy: { orderIndex: "asc" } } },
  });
}

export async function deleteModelDefinition(workspaceId: string, id: string) {
  const model = await prisma.modelDefinition.findFirst({ where: { id, workspaceId } });
  if (!model) throw new NotFoundError("Model");

  // Count affected entities for response
  const entityCount = await prisma.entity.count({ where: { modelDefinitionId: id } });

  // Cascade: disconnect proposals, delete versions, delete entities
  if (entityCount > 0) {
    await prisma.proposal.updateMany({
      where: { entity: { modelDefinitionId: id } },
      data: { entityId: null },
    });
    await prisma.entityVersion.deleteMany({
      where: { entity: { modelDefinitionId: id } },
    });
    await prisma.$executeRaw`DELETE FROM entity WHERE model_definition_id = ${id}::uuid`;
  }

  // Delete governance policies (polymorphic, no FK)
  await prisma.governancePolicy.deleteMany({ where: { targetType: "model", targetId: id } });

  // Delete bindings, fields (Prisma cascade handles some)
  await prisma.datasetModelBinding.deleteMany({ where: { modelDefinitionId: id } });
  await prisma.fieldDefinition.deleteMany({ where: { modelDefinitionId: id } });

  // Finally delete the model
  await prisma.modelDefinition.delete({ where: { id } });

  return { deleted: true, key: model.key, entitiesDeleted: entityCount };
}

// ─── Field Definition ────────────────────────────────

/** Throws NotFoundError if model isn't in workspace. */
async function assertModelInWorkspace(workspaceId: string, modelId: string) {
  const m = await prisma.modelDefinition.findFirst({ where: { id: modelId, workspaceId } });
  if (!m) throw new NotFoundError("Model");
  return m;
}

/**
 * Enforce mode-specific invariants on geometry field creation/update.
 * - 2D / 3D: heightFieldKey + baseHeightFieldKey must NOT be set
 * - 2.5D: heightFieldKey REQUIRED, must point to a "number" field on the same model;
 *         baseHeightFieldKey optional, same rules; both must differ from the geometry field's own key
 *         and from each other.
 * Called with `selfKey` = the geometry field's own key (so we can exclude it from same-model lookups
 * and reject self-references).
 */
async function validateGeometryMode(
  modelDefinitionId: string,
  selfKey: string,
  data: { geometryMode?: string | null; heightFieldKey?: string | null; baseHeightFieldKey?: string | null },
) {
  const mode = data.geometryMode ?? null;
  const h = data.heightFieldKey ?? null;
  const b = data.baseHeightFieldKey ?? null;

  if (mode === null || mode === "2D" || mode === "3D") {
    if (h || b) {
      throw new BusinessError(
        `heightFieldKey / baseHeightFieldKey only valid when geometryMode = "2.5D" (got mode="${mode}")`,
      );
    }
    return;
  }
  if (mode === "2.5D") {
    if (!h) throw new BusinessError(`2.5D geometry requires heightFieldKey to be set`);
    if (h === selfKey) throw new BusinessError(`heightFieldKey cannot reference the geometry field itself ("${selfKey}")`);
    if (b === selfKey) throw new BusinessError(`baseHeightFieldKey cannot reference the geometry field itself ("${selfKey}")`);
    if (b && b === h) throw new BusinessError(`baseHeightFieldKey must differ from heightFieldKey`);

    const referencedKeys = b ? [h, b] : [h];
    const fields = await prisma.fieldDefinition.findMany({
      where: { modelDefinitionId, key: { in: referencedKeys } },
      select: { key: true, fieldType: true },
    });
    const byKey = new Map(fields.map((f) => [f.key, f.fieldType]));
    for (const k of referencedKeys) {
      const ft = byKey.get(k);
      if (!ft) throw new BusinessError(`Referenced field "${k}" does not exist on this model — create it before linking to the geometry field`);
      if (ft !== "number") throw new BusinessError(`Referenced field "${k}" must be of fieldType "number" (found "${ft}")`);
    }
    return;
  }
  throw new BusinessError(`Invalid geometryMode "${mode}" — expected "2D", "2.5D", or "3D"`);
}

export async function addField(
  workspaceId: string,
  modelDefinitionId: string,
  data: {
    key: string;
    label: string;
    fieldType: string;
    isRequired?: boolean;
    defaultValue?: unknown;
    enumValues?: string[];
    validationJson?: object;
    referenceModelKey?: string;
    geometryType?: "NONE" | "POINT" | "LINESTRING" | "POLYGON" | "MIXED";
    geometrySrid?: number;
    geometryMode?: "2D" | "2.5D" | "3D";
    heightFieldKey?: string;
    baseHeightFieldKey?: string;
    orderIndex?: number;
  },
) {
  await assertModelInWorkspace(workspaceId, modelDefinitionId);
  if (data.fieldType === "geometry") {
    await validateGeometryMode(modelDefinitionId, data.key, {
      geometryMode: data.geometryMode,
      heightFieldKey: data.heightFieldKey,
      baseHeightFieldKey: data.baseHeightFieldKey,
    });
  }
  return prisma.fieldDefinition.create({
    data: {
      modelDefinitionId,
      key: data.key,
      label: data.label,
      fieldType: data.fieldType as any,
      isRequired: data.isRequired ?? false,
      defaultValue: data.defaultValue !== undefined ? (data.defaultValue as any) : undefined,
      enumValues: data.enumValues ?? undefined,
      validationJson: data.validationJson ?? undefined,
      referenceModelKey: data.referenceModelKey ?? undefined,
      geometryType: data.geometryType ?? undefined,
      geometrySrid: data.geometrySrid ?? undefined,
      geometryMode: data.geometryMode ?? undefined,
      heightFieldKey: data.heightFieldKey ?? undefined,
      baseHeightFieldKey: data.baseHeightFieldKey ?? undefined,
      orderIndex: data.orderIndex ?? 0,
    },
  });
}

export async function updateField(
  workspaceId: string,
  fieldId: string,
  data: {
    label?: string;
    fieldType?: string;
    isRequired?: boolean;
    defaultValue?: unknown;
    enumValues?: string[];
    validationJson?: object;
    geometryType?: "NONE" | "POINT" | "LINESTRING" | "POLYGON" | "MIXED";
    geometrySrid?: number;
    geometryMode?: "2D" | "2.5D" | "3D";
    heightFieldKey?: string | null;
    baseHeightFieldKey?: string | null;
    orderIndex?: number;
  },
) {
  const field = await prisma.fieldDefinition.findUnique({
    where: { id: fieldId },
    include: { modelDefinition: { select: { workspaceId: true } } },
  });
  if (!field || field.modelDefinition.workspaceId !== workspaceId) throw new NotFoundError("Field");

  // Geometry mode is immutable (same as fieldType / geometryType — see field-immutability rules).
  if (data.geometryMode !== undefined && data.geometryMode !== field.geometryMode) {
    throw new BusinessError(
      `geometryMode is immutable; delete and recreate the field to change it (current: "${field.geometryMode}", requested: "${data.geometryMode}")`,
    );
  }

  // If the field IS a 2.5D geometry, allow editing heightFieldKey / baseHeightFieldKey (these are
  // attribute-references, not geometry-intrinsic, so they're safer to mutate).
  if (field.fieldType === "geometry" && field.geometryMode === "2.5D" &&
      (data.heightFieldKey !== undefined || data.baseHeightFieldKey !== undefined)) {
    await validateGeometryMode(field.modelDefinitionId, field.key, {
      geometryMode: "2.5D",
      heightFieldKey: data.heightFieldKey !== undefined ? data.heightFieldKey : field.heightFieldKey,
      baseHeightFieldKey: data.baseHeightFieldKey !== undefined ? data.baseHeightFieldKey : field.baseHeightFieldKey,
    });
  }

  const updateData: Record<string, unknown> = {};
  if (data.label !== undefined) updateData.label = data.label;
  if (data.fieldType !== undefined) updateData.fieldType = data.fieldType;
  if (data.isRequired !== undefined) updateData.isRequired = data.isRequired;
  if (data.defaultValue !== undefined) updateData.defaultValue = data.defaultValue;
  if (data.enumValues !== undefined) updateData.enumValues = data.enumValues;
  if (data.validationJson !== undefined) updateData.validationJson = data.validationJson;
  if (data.geometryType !== undefined) updateData.geometryType = data.geometryType;
  if (data.geometrySrid !== undefined) updateData.geometrySrid = data.geometrySrid;
  if (data.heightFieldKey !== undefined) updateData.heightFieldKey = data.heightFieldKey;
  if (data.baseHeightFieldKey !== undefined) updateData.baseHeightFieldKey = data.baseHeightFieldKey;
  if (data.orderIndex !== undefined) updateData.orderIndex = data.orderIndex;

  return prisma.fieldDefinition.update({
    where: { id: fieldId },
    data: updateData,
  });
}

export async function removeField(workspaceId: string, fieldId: string) {
  const field = await prisma.fieldDefinition.findUnique({
    where: { id: fieldId },
    include: { modelDefinition: { select: { workspaceId: true } } },
  });
  if (!field || field.modelDefinition.workspaceId !== workspaceId) throw new NotFoundError("Field");
  return prisma.fieldDefinition.delete({ where: { id: fieldId } });
}

export async function reorderFields(workspaceId: string, modelDefinitionId: string, fieldKeys: string[]) {
  await assertModelInWorkspace(workspaceId, modelDefinitionId);
  await prisma.$transaction(
    fieldKeys.map((key, i) =>
      prisma.fieldDefinition.updateMany({
        where: { modelDefinitionId, key },
        data: { orderIndex: i },
      }),
    ),
  );
}

// ─── Model Schema (for frontend form generation) ─────

/** Workspace-agnostic schema lookup (used by Delivery / OGC where dataset id implies the workspace). */
export async function getModelSchemaById(modelDefinitionId: string) {
  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelDefinitionId },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
    },
  });
  if (!model) return null;
  return {
    id: model.id,
    key: model.key,
    name: model.name,
    primaryGeometryField: model.primaryGeometryField,
    fields: model.fields.map((f) => ({
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      isRequired: f.isRequired,
      defaultValue: f.defaultValue,
      enumValues: f.enumValues,
      validation: f.validationJson,
      referenceModelKey: f.referenceModelKey,
      ...(f.fieldType === "geometry"
        ? {
            geometryType: f.geometryType,
            geometrySrid: f.geometrySrid,
            geometryMode: f.geometryMode,
            heightFieldKey: f.heightFieldKey,
            baseHeightFieldKey: f.baseHeightFieldKey,
          }
        : {}),
    })),
  };
}

export async function getModelSchema(workspaceId: string, modelDefinitionId: string) {
  const model = await prisma.modelDefinition.findFirst({
    where: { id: modelDefinitionId, workspaceId },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
    },
  });
  if (!model) return null;

  return {
    id: model.id,
    key: model.key,
    name: model.name,
    primaryGeometryField: model.primaryGeometryField,
    fields: model.fields.map((f) => ({
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      isRequired: f.isRequired,
      defaultValue: f.defaultValue,
      enumValues: f.enumValues,
      validation: f.validationJson,
      referenceModelKey: f.referenceModelKey,
      ...(f.fieldType === "geometry"
        ? {
            geometryType: f.geometryType,
            geometrySrid: f.geometrySrid,
            geometryMode: f.geometryMode,
            heightFieldKey: f.heightFieldKey,
            baseHeightFieldKey: f.baseHeightFieldKey,
          }
        : {}),
    })),
  };
}

// ─── Dataset Model Binding ───────────────────────────

/** Throws NotFoundError if dataset isn't in workspace. */
async function assertDatasetInWorkspace(workspaceId: string, datasetId: string) {
  const d = await prisma.datasetDefinition.findFirst({ where: { id: datasetId, workspaceId } });
  if (!d) throw new NotFoundError("Dataset");
  return d;
}

export async function createBinding(
  workspaceId: string,
  data: {
    datasetDefinitionId: string;
    modelDefinitionId: string;
    filterJson?: object;
    projectionJson?: object;
  },
) {
  // Both dataset and model must be in current workspace.
  await assertDatasetInWorkspace(workspaceId, data.datasetDefinitionId);
  await assertModelInWorkspace(workspaceId, data.modelDefinitionId);

  return prisma.datasetModelBinding.create({
    data: {
      datasetDefinitionId: data.datasetDefinitionId,
      modelDefinitionId: data.modelDefinitionId,
      filterJson: data.filterJson ?? undefined,
      projectionJson: data.projectionJson ?? undefined,
    },
    include: { modelDefinition: true },
  });
}

export async function listBindings(workspaceId: string, datasetDefinitionId: string) {
  await assertDatasetInWorkspace(workspaceId, datasetDefinitionId);
  return prisma.datasetModelBinding.findMany({
    where: { datasetDefinitionId },
    include: { modelDefinition: true },
  });
}

export async function updateBinding(
  workspaceId: string,
  id: string,
  data: { filterJson?: object | null; projectionJson?: object | null },
) {
  const b = await prisma.datasetModelBinding.findUnique({
    where: { id },
    include: { datasetDefinition: { select: { workspaceId: true } } },
  });
  if (!b || b.datasetDefinition.workspaceId !== workspaceId) throw new NotFoundError("Binding");

  return prisma.datasetModelBinding.update({
    where: { id },
    data: {
      filterJson: (data.filterJson === null ? null : data.filterJson) as any,
      projectionJson: (data.projectionJson === null ? null : data.projectionJson) as any,
    },
    include: { modelDefinition: true },
  });
}

export async function removeBinding(workspaceId: string, id: string) {
  const b = await prisma.datasetModelBinding.findUnique({
    where: { id },
    include: { datasetDefinition: { select: { workspaceId: true } } },
  });
  if (!b || b.datasetDefinition.workspaceId !== workspaceId) throw new NotFoundError("Binding");
  return prisma.datasetModelBinding.delete({ where: { id } });
}

// ─── Governance Policy ───────────────────────────────

export async function upsertGovernancePolicy(
  workspaceId: string,
  data: {
    targetType: "model" | "dataset";
    targetId: string;
    requireProposal?: boolean;
    approvalMode?: "manual" | "auto";
    publishMode?: "manual" | "auto";
  },
) {
  // Target must be in current workspace
  if (data.targetType === "model") {
    const model = await prisma.modelDefinition.findFirst({
      where: { id: data.targetId, workspaceId },
    });
    if (!model) throw new BusinessError(`Model ${data.targetId} not found in this workspace`);
  } else if (data.targetType === "dataset") {
    const dataset = await prisma.datasetDefinition.findFirst({
      where: { id: data.targetId, workspaceId },
    });
    if (!dataset) throw new BusinessError(`Dataset ${data.targetId} not found in this workspace`);
  }

  return prisma.governancePolicy.upsert({
    where: {
      targetType_targetId: {
        targetType: data.targetType,
        targetId: data.targetId,
      },
    },
    create: {
      targetType: data.targetType,
      targetId: data.targetId,
      requireProposal: data.requireProposal ?? true,
      approvalMode: data.approvalMode ?? "manual",
      publishMode: data.publishMode ?? "manual",
    },
    update: {
      requireProposal: data.requireProposal,
      approvalMode: data.approvalMode,
      publishMode: data.publishMode,
    },
  });
}

export async function getGovernancePolicy(
  workspaceId: string,
  targetType: "model" | "dataset",
  targetId: string,
) {
  // Verify target is in the requested workspace
  if (targetType === "model") {
    const model = await prisma.modelDefinition.findFirst({ where: { id: targetId, workspaceId } });
    if (!model) return null;
  } else {
    const dataset = await prisma.datasetDefinition.findFirst({
      where: { id: targetId, workspaceId },
    });
    if (!dataset) return null;
  }
  return prisma.governancePolicy.findUnique({
    where: {
      targetType_targetId: { targetType, targetId },
    },
  });
}

export async function deleteGovernancePolicy(workspaceId: string, id: string) {
  const policy = await prisma.governancePolicy.findUnique({ where: { id } });
  if (!policy) throw new NotFoundError("GovernancePolicy");
  // Confirm target is in workspace
  if (policy.targetType === "model") {
    const m = await prisma.modelDefinition.findFirst({
      where: { id: policy.targetId, workspaceId },
    });
    if (!m) throw new NotFoundError("GovernancePolicy");
  } else {
    const d = await prisma.datasetDefinition.findFirst({
      where: { id: policy.targetId, workspaceId },
    });
    if (!d) throw new NotFoundError("GovernancePolicy");
  }
  return prisma.governancePolicy.delete({ where: { id } });
}
